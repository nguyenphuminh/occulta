//! Math shared by the Occulta contracts: BN254 field, circomlib Poseidon, the append-only Merkle
//! tree and Groth16 verification with the circuits' verifying keys.
#![cfg_attr(target_arch = "wasm32", no_std)]
extern crate alloc;

pub mod field;
pub mod groth16;
pub mod poseidon;
mod poseidon_constants;
pub mod tree;
#[path = "generated/vk.rs"]
mod vk;

use alloy_primitives::{keccak256, Address, U256};

pub use field::SCALAR_MODULUS;
pub use poseidon_constants::ZEROS;

/// Every note ciphertext has this size (BRD 2.2.4).
pub const CIPHERTEXT_SIZE: usize = 168;
/// Amounts are 64-bit inside the proofs.
pub const MAX_AMOUNT: U256 = U256::from_limbs([u64::MAX, 0, 0, 0]);

/// Circuit identifiers taken by the verifier contract.
pub const TRANSFER: u8 = 0;
pub const FINALIZE: u8 = 1;
pub const RECLAIM: u8 = 2;
pub const SUBMIT_STATE: u8 = 3;

pub fn verifying_key(circuit: u8) -> Option<&'static groth16::VerifyingKey> {
    match circuit {
        TRANSFER => Some(&vk::TRANSFER),
        FINALIZE => Some(&vk::FINALIZE),
        RECLAIM => Some(&vk::RECLAIM),
        SUBMIT_STATE => Some(&vk::SUBMIT_STATE),
        _ => None,
    }
}

/// Reduces a 256-bit value into the scalar field without a division (any 256-bit value is below 6r).
pub fn reduce(mut x: U256) -> U256 {
    while x >= SCALAR_MODULUS {
        x -= SCALAR_MODULUS;
    }
    x
}

/// keccak256(abi.encode(recipient, keccak(ct0), keccak(ct1), keccak(ct2))) reduced into the field.
/// `ciphertexts` is the three output ciphertexts concatenated; the proof commits to this value.
pub fn ext_data_hash(recipient: Address, ciphertexts: &[u8]) -> Option<U256> {
    if ciphertexts.len() != 3 * CIPHERTEXT_SIZE {
        return None;
    }
    let mut encoded = [0u8; 128];
    encoded[12..32].copy_from_slice(recipient.as_slice());
    for i in 0..3 {
        let digest = keccak256(&ciphertexts[i * CIPHERTEXT_SIZE..(i + 1) * CIPHERTEXT_SIZE]);
        encoded[32 * (i + 1)..32 * (i + 2)].copy_from_slice(digest.as_slice());
    }
    Some(reduce(U256::from_be_bytes(keccak256(encoded).0)))
}

/// Packs a deposit's token and amount the way the circuits do: token * 2^64 + amount.
pub fn pack_amount_token(token: Address, amount: U256) -> U256 {
    (U256::from_be_slice(token.as_slice()) << 64) | amount
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_matches_modulo() {
        for x in [
            U256::ZERO,
            SCALAR_MODULUS - U256::from(1),
            SCALAR_MODULUS,
            SCALAR_MODULUS + U256::from(5),
            U256::MAX,
        ] {
            assert_eq!(reduce(x), x % SCALAR_MODULUS);
        }
    }

    #[test]
    fn ext_data_hash_needs_three_full_ciphertexts() {
        assert!(ext_data_hash(Address::ZERO, &[0u8; 3 * CIPHERTEXT_SIZE]).is_some());
        assert!(ext_data_hash(Address::ZERO, &[0u8; 3 * CIPHERTEXT_SIZE - 1]).is_none());
    }

    #[test]
    fn every_circuit_has_a_key() {
        for c in [TRANSFER, FINALIZE, RECLAIM, SUBMIT_STATE] {
            assert!(verifying_key(c).is_some());
        }
        assert!(verifying_key(4).is_none());
    }
}
