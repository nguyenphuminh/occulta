//! Occulta shielded pool (BRD 2.2.1–2.2.5): one balance per token (ETH, USDG), note commitments in
//! an append-only Poseidon Merkle tree, the last 100 roots and the spent nullifiers. Proofs are
//! checked by the Verifier contract and tree hashing runs in the Hasher contract; the Disputes
//! contract settles finalized and reclaimed channels through `settle`.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{Address, U256};
use alloy_sol_types::{sol, SolCall, SolValue};
use occulta_core::{
    ext_data_hash, pack_amount_token, tree::TREE_DEPTH, CIPHERTEXT_SIZE, MAX_AMOUNT,
    SCALAR_MODULUS, ZEROS,
};
use stylus_sdk::{
    abi::Bytes,
    call::{call, static_call, transfer::transfer_eth},
    prelude::*,
};

/// How many recent roots a proof may be built against (BRD 2.2.1).
pub const ROOT_HISTORY: u64 = 100;

sol_storage! {
    #[entrypoint]
    pub struct Pool {
        bool initialized;
        address usdg;
        address verifier;
        address hasher;
        address disputes;
        uint256 leaf_count;
        mapping(uint256 => uint256) filled_subtrees;
        mapping(uint256 => uint256) roots;
        mapping(uint256 => uint256) root_slot_plus_one;
        uint256 current_root_slot;
        mapping(uint256 => bool) nullifiers;
    }
}

sol! {
    #![sol(all_derives)]

    event NewCommitment(uint256 indexed commitment, uint256 leafIndex, bytes ciphertext);
    event NewNullifier(uint256 indexed nullifier);

    error NotInitialized();
    error AlreadyInitialized();
    error Unauthorized();
    error UnknownRoot();
    error NullifierAlreadySpent();
    error DuplicateNullifier();
    error InvalidProof();
    error InvalidAmount();
    error InvalidField();
    error TokenNotAllowed();
    error InvalidValue();
    error InvalidCiphertext();
    error InvalidExtData();
    error InvalidRecipient();
    error TreeFull();
    error TransferFailed();

    interface IERC20 {
        function transferFrom(address from, address to, uint256 value) external returns (bool);
        function transfer(address to, uint256 value) external returns (bool);
        function balanceOf(address owner) external view returns (uint256);
    }

    interface IVerifier {
        function verify(uint8 circuit, uint256[8] proof, uint256[] signals) external view returns (bool);
    }

    interface IHasher {
        function hash2(uint256 a, uint256 b) external view returns (uint256);
        function insertLeaves(uint256[20] filled, uint64 nextIndex, uint256[] leaves) external view returns (uint256[20], uint256);
    }
}

#[derive(SolidityError, Debug)]
pub enum PoolError {
    NotInitialized(NotInitialized),
    AlreadyInitialized(AlreadyInitialized),
    Unauthorized(Unauthorized),
    UnknownRoot(UnknownRoot),
    NullifierAlreadySpent(NullifierAlreadySpent),
    DuplicateNullifier(DuplicateNullifier),
    InvalidProof(InvalidProof),
    InvalidAmount(InvalidAmount),
    InvalidField(InvalidField),
    TokenNotAllowed(TokenNotAllowed),
    InvalidValue(InvalidValue),
    InvalidCiphertext(InvalidCiphertext),
    InvalidExtData(InvalidExtData),
    InvalidRecipient(InvalidRecipient),
    TreeFull(TreeFull),
    TransferFailed(TransferFailed),
}

#[public]
impl Pool {
    /// One-time wiring: this chain's USDG token and the helper contracts.
    pub fn initialize(
        &mut self,
        usdg: Address,
        verifier: Address,
        hasher: Address,
        disputes: Address,
    ) -> Result<(), PoolError> {
        if self.initialized.get() {
            return Err(PoolError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.usdg.set(usdg);
        self.verifier.set(verifier);
        self.hasher.set(hasher);
        self.disputes.set(disputes);
        let empty_root = ZEROS[TREE_DEPTH];
        self.roots.setter(U256::ZERO).set(empty_root);
        self.root_slot_plus_one
            .setter(empty_root)
            .set(U256::from(1));
        Ok(())
    }

    /// Shields `amount` of `token` (zero address = ETH). The commitment is computed here from the
    /// token and the amount actually received, so a depositor can never claim more than it paid.
    #[payable]
    pub fn deposit(
        &mut self,
        token: Address,
        amount: U256,
        inner: U256,
        ciphertext: Bytes,
    ) -> Result<(), PoolError> {
        self.require_initialized()?;
        if ciphertext.len() != CIPHERTEXT_SIZE {
            return Err(PoolError::InvalidCiphertext(InvalidCiphertext {}));
        }
        if inner >= SCALAR_MODULUS {
            return Err(PoolError::InvalidField(InvalidField {}));
        }
        let received = if token.is_zero() {
            if self.vm().msg_value() != amount {
                return Err(PoolError::InvalidValue(InvalidValue {}));
            }
            amount
        } else {
            if token != self.usdg.get() {
                return Err(PoolError::TokenNotAllowed(TokenNotAllowed {}));
            }
            if !self.vm().msg_value().is_zero() {
                return Err(PoolError::InvalidValue(InvalidValue {}));
            }
            let before = self.token_balance(token)?;
            let (sender, this) = (self.vm().msg_sender(), self.vm().contract_address());
            self.token_call(
                token,
                IERC20::transferFromCall {
                    from: sender,
                    to: this,
                    value: amount,
                }
                .abi_encode(),
            )?;
            self.token_balance(token)?.saturating_sub(before)
        };
        if received.is_zero() || received > MAX_AMOUNT {
            return Err(PoolError::InvalidAmount(InvalidAmount {}));
        }
        let commitment = self.hash2(pack_amount_token(token, received), inner)?;
        let (index, root) = self.insert(&[commitment])?;
        self.push_root(root);
        self.vm().log(NewCommitment {
            commitment,
            leafIndex: index,
            ciphertext,
        });
        Ok(())
    }

    /// Private transfer, channel funding, cooperative close or withdrawal (transfer circuit).
    /// signals = [root, publicAmount, publicToken, extDataHash, nf0, nf1, out0, out1, out2];
    /// `ciphertexts` holds the three output ciphertexts back to back.
    pub fn transact(
        &mut self,
        proof: [U256; 8],
        signals: [U256; 9],
        recipient: Address,
        ciphertexts: Bytes,
    ) -> Result<(), PoolError> {
        self.require_initialized()?;
        let [root, public_amount, public_token, ext_hash, nf0, nf1, out0, out1, out2] = signals;
        self.check_spend(root, nf0, nf1)?;
        if ext_data_hash(recipient, &ciphertexts) != Some(ext_hash) {
            return Err(PoolError::InvalidExtData(InvalidExtData {}));
        }
        if public_amount > MAX_AMOUNT {
            return Err(PoolError::InvalidAmount(InvalidAmount {}));
        }
        let payout = if public_amount.is_zero() {
            None
        } else {
            if recipient.is_zero() {
                return Err(PoolError::InvalidRecipient(InvalidRecipient {}));
            }
            Some(self.allowed_token(public_token)?)
        };
        self.verify(occulta_core::TRANSFER, proof, &signals)?;
        self.apply(nf0, nf1, [out0, out1, out2], &ciphertexts)?;
        if let Some(token) = payout {
            self.pay(token, recipient, public_amount)?;
        }
        Ok(())
    }

    /// Spends and creates notes for a finalized or reclaimed channel. Only the Disputes contract
    /// may call it, after verifying the finalize or reclaim proof against `ciphertexts`.
    pub fn settle(
        &mut self,
        root: U256,
        nf0: U256,
        nf1: U256,
        outputs: [U256; 3],
        ciphertexts: Bytes,
    ) -> Result<(), PoolError> {
        self.require_initialized()?;
        if self.vm().msg_sender() != self.disputes.get() {
            return Err(PoolError::Unauthorized(Unauthorized {}));
        }
        self.check_spend(root, nf0, nf1)?;
        if ciphertexts.len() != 3 * CIPHERTEXT_SIZE || outputs.iter().any(|c| *c >= SCALAR_MODULUS)
        {
            return Err(PoolError::InvalidCiphertext(InvalidCiphertext {}));
        }
        self.apply(nf0, nf1, outputs, &ciphertexts)
    }

    pub fn root(&self) -> U256 {
        self.roots.get(self.current_root_slot.get())
    }

    pub fn is_known_root(&self, root: U256) -> bool {
        !root.is_zero() && !self.root_slot_plus_one.get(root).is_zero()
    }

    pub fn is_spent(&self, nullifier: U256) -> bool {
        self.nullifiers.get(nullifier)
    }
}

impl Pool {
    fn require_initialized(&self) -> Result<(), PoolError> {
        if self.initialized.get() {
            Ok(())
        } else {
            Err(PoolError::NotInitialized(NotInitialized {}))
        }
    }

    fn check_spend(&self, root: U256, nf0: U256, nf1: U256) -> Result<(), PoolError> {
        if !self.is_known_root(root) {
            return Err(PoolError::UnknownRoot(UnknownRoot {}));
        }
        if nf0 == nf1 {
            return Err(PoolError::DuplicateNullifier(DuplicateNullifier {}));
        }
        if self.nullifiers.get(nf0) || self.nullifiers.get(nf1) {
            return Err(PoolError::NullifierAlreadySpent(NullifierAlreadySpent {}));
        }
        Ok(())
    }

    /// Marks both nullifiers spent and appends the three output notes with their ciphertexts.
    fn apply(
        &mut self,
        nf0: U256,
        nf1: U256,
        outputs: [U256; 3],
        ciphertexts: &[u8],
    ) -> Result<(), PoolError> {
        for nullifier in [nf0, nf1] {
            self.nullifiers.setter(nullifier).set(true);
            self.vm().log(NewNullifier { nullifier });
        }
        let (first, root) = self.insert(&outputs)?;
        for (i, commitment) in outputs.into_iter().enumerate() {
            let ciphertext =
                Bytes::from(ciphertexts[i * CIPHERTEXT_SIZE..(i + 1) * CIPHERTEXT_SIZE].to_vec());
            self.vm().log(NewCommitment {
                commitment,
                leafIndex: first + U256::from(i),
                ciphertext,
            });
        }
        self.push_root(root);
        Ok(())
    }

    /// Appends leaves to the tree; returns (index of the first one, new root).
    fn insert(&mut self, leaves: &[U256]) -> Result<(U256, U256), PoolError> {
        let first = self.leaf_count.get();
        let mut filled = [U256::ZERO; TREE_DEPTH];
        for (level, slot) in filled.iter_mut().enumerate() {
            *slot = self.filled_subtrees.get(U256::from(level));
        }
        let (updated, root) = self.insert_leaves(filled, first.as_limbs()[0], leaves)?;
        for level in 0..TREE_DEPTH {
            if updated[level] != filled[level] {
                self.filled_subtrees
                    .setter(U256::from(level))
                    .set(updated[level]);
            }
        }
        self.leaf_count.set(first + U256::from(leaves.len()));
        Ok((first, root))
    }

    /// Records a new root in the ring of recent roots, forgetting the oldest.
    fn push_root(&mut self, root: U256) {
        let next = self.current_root_slot.get().as_limbs()[0] + 1;
        let slot = U256::from(if next == ROOT_HISTORY { 0 } else { next });
        let evicted = self.roots.get(slot);
        if !evicted.is_zero() {
            self.root_slot_plus_one.setter(evicted).set(U256::ZERO);
        }
        self.roots.setter(slot).set(root);
        self.root_slot_plus_one
            .setter(root)
            .set(slot + U256::from(1));
        self.current_root_slot.set(slot);
    }

    fn allowed_token(&self, public_token: U256) -> Result<Address, PoolError> {
        if public_token.is_zero() {
            return Ok(Address::ZERO);
        }
        let usdg = self.usdg.get();
        if !usdg.is_zero() && public_token == U256::from_be_slice(usdg.as_slice()) {
            Ok(usdg)
        } else {
            Err(PoolError::TokenNotAllowed(TokenNotAllowed {}))
        }
    }

    fn pay(&mut self, token: Address, to: Address, amount: U256) -> Result<(), PoolError> {
        if token.is_zero() {
            transfer_eth(self.vm(), to, amount)
                .map_err(|_| PoolError::TransferFailed(TransferFailed {}))
        } else {
            self.token_call(
                token,
                IERC20::transferCall { to, value: amount }.abi_encode(),
            )
        }
    }

    /// Calls a token and accepts either no return data or `true`, as standard ERC-20 tokens do.
    fn token_call(&mut self, token: Address, data: Vec<u8>) -> Result<(), PoolError> {
        let context = Call::new_mutating(self);
        let out = call(self.vm(), context, token, &data)
            .map_err(|_| PoolError::TransferFailed(TransferFailed {}))?;
        if out.is_empty() || <bool as SolValue>::abi_decode(&out).unwrap_or(false) {
            Ok(())
        } else {
            Err(PoolError::TransferFailed(TransferFailed {}))
        }
    }

    fn token_balance(&self, token: Address) -> Result<U256, PoolError> {
        let data = IERC20::balanceOfCall {
            owner: self.vm().contract_address(),
        }
        .abi_encode();
        let out = static_call(self.vm(), Call::new(), token, &data)
            .map_err(|_| PoolError::TransferFailed(TransferFailed {}))?;
        IERC20::balanceOfCall::abi_decode_returns(&out)
            .map_err(|_| PoolError::TransferFailed(TransferFailed {}))
    }

    // On-chain the helpers are separate contracts (keeping each under the Stylus size limit);
    // host builds call the same code directly so native tests run real hashing and verification.

    #[cfg(target_arch = "wasm32")]
    fn verify(&self, circuit: u8, proof: [U256; 8], signals: &[U256]) -> Result<(), PoolError> {
        let data = IVerifier::verifyCall {
            circuit,
            proof,
            signals: signals.to_vec(),
        }
        .abi_encode();
        let ok = static_call(self.vm(), Call::new(), self.verifier.get(), &data)
            .ok()
            .and_then(|out| IVerifier::verifyCall::abi_decode_returns(&out).ok())
            .unwrap_or(false);
        ok.then_some(())
            .ok_or(PoolError::InvalidProof(InvalidProof {}))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn verify(&self, circuit: u8, proof: [U256; 8], signals: &[U256]) -> Result<(), PoolError> {
        let ok = occulta_core::verifying_key(circuit).is_some_and(|vk| {
            occulta_core::groth16::verify(&occulta_core::groth16::Native, vk, &proof, signals)
        });
        ok.then_some(())
            .ok_or(PoolError::InvalidProof(InvalidProof {}))
    }

    #[cfg(target_arch = "wasm32")]
    fn hash2(&self, a: U256, b: U256) -> Result<U256, PoolError> {
        let data = IHasher::hash2Call { a, b }.abi_encode();
        static_call(self.vm(), Call::new(), self.hasher.get(), &data)
            .ok()
            .and_then(|out| IHasher::hash2Call::abi_decode_returns(&out).ok())
            .ok_or(PoolError::InvalidField(InvalidField {}))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn hash2(&self, a: U256, b: U256) -> Result<U256, PoolError> {
        Ok(occulta_core::poseidon::hash2(a, b))
    }

    #[cfg(target_arch = "wasm32")]
    fn insert_leaves(
        &self,
        filled: [U256; TREE_DEPTH],
        next_index: u64,
        leaves: &[U256],
    ) -> Result<([U256; TREE_DEPTH], U256), PoolError> {
        let data = IHasher::insertLeavesCall {
            filled,
            nextIndex: next_index,
            leaves: leaves.to_vec(),
        }
        .abi_encode();
        static_call(self.vm(), Call::new(), self.hasher.get(), &data)
            .ok()
            .and_then(|out| IHasher::insertLeavesCall::abi_decode_returns(&out).ok())
            .map(|r| (r._0, r._1))
            .ok_or(PoolError::TreeFull(TreeFull {}))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn insert_leaves(
        &self,
        mut filled: [U256; TREE_DEPTH],
        next_index: u64,
        leaves: &[U256],
    ) -> Result<([U256; TREE_DEPTH], U256), PoolError> {
        let root = occulta_core::tree::insert_leaves(&mut filled, next_index, leaves)
            .ok_or(PoolError::TreeFull(TreeFull {}))?;
        Ok((filled, root))
    }
}

#[cfg(test)]
mod tests;
