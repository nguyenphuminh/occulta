//! circomlib-compatible Poseidon with two inputs (t = 3, 8 full and 57 partial rounds), the hash
//! of the pool's commitments and Merkle tree. Must match `hash2` in the framework and circuits.

use crate::field::Fr;
use crate::poseidon_constants::{C, M};
use alloy_primitives::U256;

const FULL_ROUNDS: usize = 8;
const PARTIAL_ROUNDS: usize = 57;

/// H(a, b). Both inputs must be field elements (below the scalar modulus).
pub fn hash2(a: U256, b: U256) -> U256 {
    let mut state = [Fr::ZERO, Fr::from_u256(a), Fr::from_u256(b)];
    for round in 0..FULL_ROUNDS + PARTIAL_ROUNDS {
        for (i, s) in state.iter_mut().enumerate() {
            *s = s.add(C[round * 3 + i]);
        }
        if !(FULL_ROUNDS / 2..FULL_ROUNDS / 2 + PARTIAL_ROUNDS).contains(&round) {
            for s in state.iter_mut() {
                *s = s.pow5();
            }
        } else {
            state[0] = state[0].pow5();
        }
        let mut mixed = [Fr::ZERO; 3];
        for (x, out) in mixed.iter_mut().enumerate() {
            for (y, s) in state.iter().enumerate() {
                *out = out.add(M[x][y].mul(*s));
            }
        }
        state = mixed;
    }
    state[0].to_u256()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon_constants::ZEROS;

    #[test]
    fn matches_the_circomlib_reference_vector() {
        let expected = U256::from_str_radix(
            "7853200120776062878684798364095072458815029376092732009249414926327459813530",
            10,
        )
        .unwrap();
        assert_eq!(hash2(U256::from(1), U256::from(2)), expected);
    }

    #[test]
    fn empty_subtree_values_chain_through_the_hash() {
        for level in 0..ZEROS.len() - 1 {
            assert_eq!(hash2(ZEROS[level], ZEROS[level]), ZEROS[level + 1]);
        }
    }
}
