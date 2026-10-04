//! Stateless Poseidon hasher for the pool: the deposit commitment and the Merkle path updates.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::U256;
use alloy_sol_types::{sol, SolError};
use occulta_core::{tree, SCALAR_MODULUS};
use stylus_sdk::prelude::*;

sol! {
    error InvalidField();
    error TreeFull();
}

#[storage]
#[entrypoint]
pub struct Hasher;

#[public]
impl Hasher {
    /// circomlib Poseidon of two field elements.
    pub fn hash2(&self, a: U256, b: U256) -> Result<U256, Vec<u8>> {
        if a >= SCALAR_MODULUS || b >= SCALAR_MODULUS {
            return Err(InvalidField {}.abi_encode());
        }
        Ok(occulta_core::poseidon::hash2(a, b))
    }

    /// Appends `leaves` at `next_index` given the tree's filled subtrees; returns the updated
    /// subtrees and the new root.
    pub fn insert_leaves(
        &self,
        filled: [U256; 20],
        next_index: u64,
        leaves: Vec<U256>,
    ) -> Result<([U256; 20], U256), Vec<u8>> {
        if leaves
            .iter()
            .chain(filled.iter())
            .any(|x| *x >= SCALAR_MODULUS)
        {
            return Err(InvalidField {}.abi_encode());
        }
        let mut filled = filled;
        let root = tree::insert_leaves(&mut filled, next_index, &leaves)
            .ok_or_else(|| TreeFull {}.abi_encode())?;
        Ok((filled, root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::testing::TestVM;

    #[test]
    fn hashes_like_circomlib_and_rejects_non_field_inputs() {
        let vm = TestVM::default();
        let hasher = Hasher::from(&vm);
        let expected = U256::from_str_radix(
            "7853200120776062878684798364095072458815029376092732009249414926327459813530",
            10,
        )
        .unwrap();
        assert_eq!(
            hasher.hash2(U256::from(1), U256::from(2)).unwrap(),
            expected
        );
        assert!(hasher.hash2(SCALAR_MODULUS, U256::from(2)).is_err());
    }

    #[test]
    fn insert_leaves_returns_the_same_root_as_the_core_tree() {
        let vm = TestVM::default();
        let hasher = Hasher::from(&vm);
        let leaves = [U256::from(11), U256::from(22), U256::from(33)];
        let mut expected = [U256::ZERO; 20];
        let root = tree::insert_leaves(&mut expected, 0, &leaves).unwrap();
        assert_eq!(
            hasher
                .insert_leaves([U256::ZERO; 20], 0, leaves.to_vec())
                .unwrap(),
            (expected, root)
        );
        assert!(hasher
            .insert_leaves([U256::ZERO; 20], 1 << 20, leaves.to_vec())
            .is_err());
        assert!(hasher
            .insert_leaves([U256::ZERO; 20], 0, Vec::new())
            .is_err());
        assert!(hasher
            .insert_leaves([U256::ZERO; 20], 0, alloc::vec![SCALAR_MODULUS])
            .is_err());
    }
}
