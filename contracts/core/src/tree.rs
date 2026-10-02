//! The pool's append-only Merkle tree: depth 20, empty leaves 0, Poseidon nodes (BRD 2.2.1).

use crate::poseidon::hash2;
use crate::poseidon_constants::ZEROS;
use alloy_primitives::U256;

pub const TREE_DEPTH: usize = 20;

/// Appends `leaves` starting at position `next_index`. `filled[level]` holds the latest left child
/// at each level and is updated in place. Returns the new root, or `None` if the tree would overflow
/// or nothing is inserted.
pub fn insert_leaves(
    filled: &mut [U256; TREE_DEPTH],
    next_index: u64,
    leaves: &[U256],
) -> Option<U256> {
    let mut root = None;
    for (k, leaf) in leaves.iter().enumerate() {
        let index = next_index + k as u64;
        if index >= 1 << TREE_DEPTH {
            return None;
        }
        let mut node = *leaf;
        let mut position = index;
        for level in 0..TREE_DEPTH {
            if position & 1 == 1 {
                node = hash2(filled[level], node);
            } else {
                filled[level] = node;
                node = hash2(node, ZEROS[level]);
            }
            position >>= 1;
        }
        root = Some(node);
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    /// Reference: rebuild the whole tree level by level.
    fn full_root(leaves: &[U256]) -> U256 {
        let mut layer: Vec<U256> = leaves.to_vec();
        for level in 0..TREE_DEPTH {
            let mut next: Vec<U256> = layer
                .chunks(2)
                .map(|pair| hash2(pair[0], pair.get(1).copied().unwrap_or(ZEROS[level])))
                .collect();
            if next.is_empty() {
                next.push(ZEROS[level + 1]);
            }
            layer = next;
        }
        layer[0]
    }

    #[test]
    fn incremental_inserts_match_a_full_rebuild() {
        let mut filled = [U256::ZERO; TREE_DEPTH];
        let mut leaves = Vec::new();
        for i in 0..9u64 {
            let batch = [
                U256::from(1000 + 3 * i),
                U256::from(1001 + 3 * i),
                U256::from(1002 + 3 * i),
            ];
            let root = insert_leaves(&mut filled, leaves.len() as u64, &batch).unwrap();
            leaves.extend_from_slice(&batch);
            assert_eq!(root, full_root(&leaves));
        }
    }

    #[test]
    fn refuses_to_overflow_or_insert_nothing() {
        let mut filled = [U256::ZERO; TREE_DEPTH];
        assert!(insert_leaves(&mut filled, (1 << TREE_DEPTH) - 1, &[U256::from(1)]).is_some());
        assert!(insert_leaves(&mut filled, 1 << TREE_DEPTH, &[U256::from(1)]).is_none());
        assert!(insert_leaves(
            &mut filled,
            (1 << TREE_DEPTH) - 1,
            &[U256::from(1), U256::from(2)]
        )
        .is_none());
        assert!(insert_leaves(&mut filled, 0, &[]).is_none());
    }
}
