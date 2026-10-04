//! Occulta channel disputes (BRD 2.2.10): submit or answer a state, finalize it after the dispute
//! window, and reclaim contributions the finalized state left out. Notes move through the Pool's
//! `settle`, which only this contract may call.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{Address, U256};
use alloy_sol_types::{sol, SolCall};
use occulta_core::ext_data_hash;
use stylus_sdk::{
    abi::Bytes,
    call::{call, static_call},
    prelude::*,
};

/// Dispute window bounds in seconds (BRD 2.2.10: 3 to 7 days). Dev-node end-to-end builds, which
/// cannot fast-forward time, lower the minimum so a dispute can be finalized within a test.
#[cfg(not(feature = "e2e-short-window"))]
pub const MIN_WINDOW: u64 = 3 * 86_400;
#[cfg(feature = "e2e-short-window")]
pub const MIN_WINDOW: u64 = 10;
pub const MAX_WINDOW: u64 = 7 * 86_400;

sol_storage! {
    #[entrypoint]
    pub struct Disputes {
        bool initialized;
        address pool;
        address verifier;
        mapping(uint256 => Dispute) disputes;
        mapping(uint256 => bool) finalized;
    }

    pub struct Dispute {
        bool pending;
        uint256 nonce;
        uint256 state_hash;
        uint256 deadline;
    }
}

sol! {
    #![sol(all_derives)]

    event DisputeSubmitted(uint256 indexed channelNullifier, uint256 nonce, uint256 stateHash, uint256 deadline);
    event ChannelFinalized(uint256 indexed channelNullifier);

    error NotInitialized();
    error AlreadyInitialized();
    error UnknownRoot();
    error InvalidProof();
    error InvalidExtData();
    error InvalidWindow();
    error ChannelAlreadyFinalized();
    error StaleState();
    error NoPendingDispute();
    error StateMismatch();
    error DeadlineNotReached();
    error ChannelNotFinalized();
    error SettlementFailed();

    interface IPool {
        function isKnownRoot(uint256 root) external view returns (bool);
        function settle(uint256 root, uint256 nf0, uint256 nf1, uint256[3] outputs, bytes ciphertexts) external;
    }

    interface IVerifier {
        function verify(uint8 circuit, uint256[8] proof, uint256[] signals) external view returns (bool);
    }
}

#[derive(SolidityError, Debug)]
pub enum DisputeError {
    NotInitialized(NotInitialized),
    AlreadyInitialized(AlreadyInitialized),
    UnknownRoot(UnknownRoot),
    InvalidProof(InvalidProof),
    InvalidExtData(InvalidExtData),
    InvalidWindow(InvalidWindow),
    ChannelAlreadyFinalized(ChannelAlreadyFinalized),
    StaleState(StaleState),
    NoPendingDispute(NoPendingDispute),
    StateMismatch(StateMismatch),
    DeadlineNotReached(DeadlineNotReached),
    ChannelNotFinalized(ChannelNotFinalized),
    SettlementFailed(SettlementFailed),
}

#[public]
impl Disputes {
    pub fn initialize(&mut self, pool: Address, verifier: Address) -> Result<(), DisputeError> {
        if self.initialized.get() {
            return Err(DisputeError::AlreadyInitialized(AlreadyInitialized {}));
        }
        self.initialized.set(true);
        self.pool.set(pool);
        self.verifier.set(verifier);
        Ok(())
    }

    /// Starts or answers a dispute (submit-state circuit). A higher nonce replaces the pending
    /// state; the deadline stays the one set by the first submission.
    /// signals = [root, channelNullifier, nonce, stateHash, window].
    pub fn submit_state(
        &mut self,
        proof: [U256; 8],
        signals: [U256; 5],
    ) -> Result<(), DisputeError> {
        self.require_initialized()?;
        let [root, channel_nullifier, nonce, state_hash, window] = signals;
        if self.finalized.get(channel_nullifier) {
            return Err(DisputeError::ChannelAlreadyFinalized(
                ChannelAlreadyFinalized {},
            ));
        }
        if window < U256::from(MIN_WINDOW) || window > U256::from(MAX_WINDOW) {
            return Err(DisputeError::InvalidWindow(InvalidWindow {}));
        }
        let pending = self.disputes.get(channel_nullifier).pending.get();
        if pending && nonce <= self.disputes.get(channel_nullifier).nonce.get() {
            return Err(DisputeError::StaleState(StaleState {}));
        }
        if !self.pool_knows_root(root) {
            return Err(DisputeError::UnknownRoot(UnknownRoot {}));
        }
        self.verify(occulta_core::SUBMIT_STATE, proof, &signals)?;
        let now = U256::from(self.vm().block_timestamp());
        let mut dispute = self.disputes.setter(channel_nullifier);
        if !pending {
            dispute.pending.set(true);
            dispute.deadline.set(now + window);
        }
        dispute.nonce.set(nonce);
        dispute.state_hash.set(state_hash);
        let deadline = dispute.deadline.get();
        self.vm().log(DisputeSubmitted {
            channelNullifier: channel_nullifier,
            nonce,
            stateHash: state_hash,
            deadline,
        });
        Ok(())
    }

    /// Settles the pending state after its deadline (finalize circuit).
    /// signals = [root, extDataHash, nf0, nf1, out0, out1, out2, channelNullifier, stateHash].
    pub fn finalize(
        &mut self,
        proof: [U256; 8],
        signals: [U256; 9],
        ciphertexts: Bytes,
    ) -> Result<(), DisputeError> {
        self.require_initialized()?;
        let [root, ext_hash, nf0, nf1, out0, out1, out2, channel_nullifier, state_hash] = signals;
        if self.finalized.get(channel_nullifier) {
            return Err(DisputeError::ChannelAlreadyFinalized(
                ChannelAlreadyFinalized {},
            ));
        }
        let dispute = self.disputes.get(channel_nullifier);
        if !dispute.pending.get() {
            return Err(DisputeError::NoPendingDispute(NoPendingDispute {}));
        }
        if dispute.state_hash.get() != state_hash {
            return Err(DisputeError::StateMismatch(StateMismatch {}));
        }
        if U256::from(self.vm().block_timestamp()) < dispute.deadline.get() {
            return Err(DisputeError::DeadlineNotReached(DeadlineNotReached {}));
        }
        if ext_data_hash(Address::ZERO, &ciphertexts) != Some(ext_hash) {
            return Err(DisputeError::InvalidExtData(InvalidExtData {}));
        }
        self.verify(occulta_core::FINALIZE, proof, &signals)?;
        self.disputes.setter(channel_nullifier).pending.set(false);
        self.finalized.setter(channel_nullifier).set(true);
        self.settle(root, nf0, nf1, [out0, out1, out2], ciphertexts)?;
        self.vm().log(ChannelFinalized {
            channelNullifier: channel_nullifier,
        });
        Ok(())
    }

    /// Returns a contribution the finalized state did not include to its contributor (reclaim circuit).
    /// signals = [root, extDataHash, nf0, nf1, out0, out1, out2, channelNullifier].
    pub fn reclaim(
        &mut self,
        proof: [U256; 8],
        signals: [U256; 8],
        ciphertexts: Bytes,
    ) -> Result<(), DisputeError> {
        self.require_initialized()?;
        let [root, ext_hash, nf0, nf1, out0, out1, out2, channel_nullifier] = signals;
        if !self.finalized.get(channel_nullifier) {
            return Err(DisputeError::ChannelNotFinalized(ChannelNotFinalized {}));
        }
        if ext_data_hash(Address::ZERO, &ciphertexts) != Some(ext_hash) {
            return Err(DisputeError::InvalidExtData(InvalidExtData {}));
        }
        self.verify(occulta_core::RECLAIM, proof, &signals)?;
        self.settle(root, nf0, nf1, [out0, out1, out2], ciphertexts)
    }

    /// (pending, nonce, stateHash, deadline) of a channel's dispute.
    pub fn dispute_of(&self, channel_nullifier: U256) -> (bool, U256, U256, U256) {
        let d = self.disputes.get(channel_nullifier);
        (
            d.pending.get(),
            d.nonce.get(),
            d.state_hash.get(),
            d.deadline.get(),
        )
    }

    pub fn is_finalized(&self, channel_nullifier: U256) -> bool {
        self.finalized.get(channel_nullifier)
    }

    pub fn window_bounds(&self) -> (u64, u64) {
        (MIN_WINDOW, MAX_WINDOW)
    }
}

impl Disputes {
    fn require_initialized(&self) -> Result<(), DisputeError> {
        if self.initialized.get() {
            Ok(())
        } else {
            Err(DisputeError::NotInitialized(NotInitialized {}))
        }
    }

    fn pool_knows_root(&self, root: U256) -> bool {
        let data = IPool::isKnownRootCall { root }.abi_encode();
        static_call(self.vm(), Call::new(), self.pool.get(), &data)
            .ok()
            .and_then(|out| IPool::isKnownRootCall::abi_decode_returns(&out).ok())
            .unwrap_or(false)
    }

    fn settle(
        &mut self,
        root: U256,
        nf0: U256,
        nf1: U256,
        outputs: [U256; 3],
        ciphertexts: Bytes,
    ) -> Result<(), DisputeError> {
        let data = IPool::settleCall {
            root,
            nf0,
            nf1,
            outputs,
            ciphertexts,
        }
        .abi_encode();
        let pool = self.pool.get();
        let context = Call::new_mutating(self);
        call(self.vm(), context, pool, &data)
            .map(|_| ())
            .map_err(|_| DisputeError::SettlementFailed(SettlementFailed {}))
    }

    #[cfg(target_arch = "wasm32")]
    fn verify(&self, circuit: u8, proof: [U256; 8], signals: &[U256]) -> Result<(), DisputeError> {
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
            .ok_or(DisputeError::InvalidProof(InvalidProof {}))
    }

    /// Host builds verify directly (see the Pool contract) so native tests check real proofs.
    #[cfg(not(target_arch = "wasm32"))]
    fn verify(&self, circuit: u8, proof: [U256; 8], signals: &[U256]) -> Result<(), DisputeError> {
        let ok = occulta_core::verifying_key(circuit).is_some_and(|vk| {
            occulta_core::groth16::verify(&occulta_core::groth16::Native, vk, &proof, signals)
        });
        ok.then_some(())
            .ok_or(DisputeError::InvalidProof(InvalidProof {}))
    }
}

#[cfg(test)]
mod tests;
