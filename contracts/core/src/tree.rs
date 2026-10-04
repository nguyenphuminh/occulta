//! The pool's append-only Merkle tree: depth 20, empty leaves 0, Poseidon nodes (BRD 2.2.1).

use crate::poseidon::hash2;
use crate::poseidon_constants::ZEROS;
use alloc::vec::Vec;
use alloy_primitives::U256;

pub const TREE_DEPTH: usize = 20;

/// Appends `leaves` starting at position `next_index`. `filled[level]` holds the latest left child
/// at each level and is updated in place. Returns the new root, or `None` if the tree would overflow
/// or nothing is inserted.
///
/// The leaves are inserted together, level by level, so they share the upper part of their paths:
/// three leaves cost about 21 hashes instead of 60.
pub fn insert_leaves(
    filled: &mut [U256; TREE_DEPTH],
    next_index: u64,
    leaves: &[U256],
) -> Option<U256> {
    if leaves.is_empty() || next_index.checked_add(leaves.len() as u64)? > 1 << TREE_DEPTH {
        return None;
    }
    // The new nodes of the current level, the first one at position `first`.
    let mut nodes: Vec<U256> = leaves.to_vec();
    let mut first = next_index;
    for level in 0..TREE_DEPTH {
        let last = first + nodes.len() as u64 - 1;
        let previous_left = filled[level];
        let mut parents = Vec::with_capacity(nodes.len() / 2 + 1);
        let mut position = first & !1;
        while position <= last {
            let left = if position < first {
                previous_left
            } else {
                nodes[(position - first) as usize]
            };
            let right = if position < last {
                nodes[(position + 1 - first) as usize]
            } else {
                ZEROS[level]
            };
            parents.push(hash2(left, right));
            position += 2;
        }
        // Remember the right-most new left child: later inserts hash against it.
        let last_left = last & !1;
        if last_left >= first {
            filled[level] = nodes[(last_left - first) as usize];
        }
        nodes = parents;
        first >>= 1;
    }
    Some(nodes[0])
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

    /// Reference: the textbook one-leaf-at-a-time insertion.
    fn insert_one(filled: &mut [U256; TREE_DEPTH], index: u64, leaf: U256) -> U256 {
        let mut node = leaf;
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
        node
    }

    #[test]
    fn batches_of_any_size_and_alignment_match_single_inserts() {
        for batch in [1usize, 2, 3, 4, 5] {
            let mut batched = [U256::ZERO; TREE_DEPTH];
            let mut single = [U256::ZERO; TREE_DEPTH];
            let mut next = 0u64;
            let mut all = Vec::new();
            for round in 0..7u64 {
                let leaves: Vec<U256> = (0..batch as u64)
                    .map(|i| U256::from(round * 100 + i + 1))
                    .collect();
                let root = insert_leaves(&mut batched, next, &leaves).unwrap();
                let mut expected = U256::ZERO;
                for (i, leaf) in leaves.iter().enumerate() {
                    expected = insert_one(&mut single, next + i as u64, *leaf);
                }
                next += batch as u64;
                all.extend_from_slice(&leaves);
                assert_eq!(root, expected, "batch {batch}, round {round}");
                assert_eq!(root, full_root(&all));
                assert_eq!(
                    batched, single,
                    "frontier after batch {batch}, round {round}"
                );
            }
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
