import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import {
  CHANNEL_DOMAIN,
  CIPHERTEXT_SIZE,
  CLOSE_DOMAIN,
  FIELD_SIZE,
  MAX_AMOUNT,
  MerkleTree,
  PAYOUT_DOMAIN,
  TREE_DEPTH,
  bytesToBigInt,
  channelPublicKeyOf,
  decryptNote,
  encryptNote,
  encryptionPublicKeyOf,
  extDataHashOf,
  fieldToBytes,
  generateChannelKey,
  hash2,
  noteCommitment,
  noteInner,
  nullifierOf,
  ownerTagOf,
  packAmountToken,
  randomFieldElement,
  signStateHash,
  toField,
  verifyStateSignature,
  zeroValues,
  type NotePreimage,
} from './index.ts';

const note = (overrides: Partial<NotePreimage> = {}): NotePreimage => ({
  amount: 100n,
  token: 0n,
  ownerTag: ownerTagOf(123n),
  salt: 456n,
  ...overrides,
});

describe('field', () => {
  it('reduces into the field and keeps random values in range', () => {
    expect(toField(FIELD_SIZE + 5n)).toBe(5n);
    expect(toField(-1n)).toBe(FIELD_SIZE - 1n);
    for (let i = 0; i < 50; i++) {
      const r = randomFieldElement();
      expect(r >= 0n && r < FIELD_SIZE).toBe(true);
    }
  });

  it('round-trips field elements through 32 bytes', () => {
    const v = randomFieldElement();
    expect(bytesToBigInt(fieldToBytes(v))).toBe(v);
  });
});

describe('poseidon', () => {
  it('matches the circomlib reference vector for H(1, 2)', () => {
    expect(hash2(1n, 2n)).toBe(7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  });

  it('domain constants are distinct field elements', () => {
    const domains = [CHANNEL_DOMAIN, CLOSE_DOMAIN, PAYOUT_DOMAIN];
    expect(new Set(domains).size).toBe(3);
    for (const d of domains) expect(d < FIELD_SIZE).toBe(true);
  });
});

describe('note', () => {
  it('packs token above the 64 amount bits', () => {
    expect(packAmountToken(5n, 1n)).toBe((1n << 64n) + 5n);
    expect(() => packAmountToken(MAX_AMOUNT + 1n, 0n)).toThrow(RangeError);
    expect(() => packAmountToken(-1n, 0n)).toThrow(RangeError);
    expect(() => packAmountToken(1n, 1n << 160n)).toThrow(RangeError);
  });

  it('commitment is H(packed, H(ownerTag, salt)) and depends on every field', () => {
    const n = note();
    expect(noteCommitment(n)).toBe(hash2(packAmountToken(n.amount, n.token), noteInner(n.ownerTag, n.salt)));
    const base = noteCommitment(n);
    expect(noteCommitment(note({ amount: 101n }))).not.toBe(base);
    expect(noteCommitment(note({ token: 1n }))).not.toBe(base);
    expect(noteCommitment(note({ ownerTag: 7n }))).not.toBe(base);
    expect(noteCommitment(note({ salt: 457n }))).not.toBe(base);
  });

  it('nullifier needs the secret and differs per note', () => {
    const c = noteCommitment(note());
    expect(nullifierOf(123n, c)).not.toBe(nullifierOf(124n, c));
    expect(nullifierOf(123n, c)).not.toBe(c);
  });
});

describe('merkle tree', () => {
  const verify = (leaf: bigint, index: number, path: bigint[]): bigint => {
    let node = leaf;
    let i = index;
    for (const sibling of path) {
      node = i % 2 === 1 ? hash2(sibling, node) : hash2(node, sibling);
      i >>= 1;
    }
    return node;
  };

  it('empty root is the top zero value', () => {
    expect(new MerkleTree().root).toBe(zeroValues()[TREE_DEPTH]);
  });

  it('proofs recompute the root for every leaf', () => {
    const leaves = Array.from({ length: 13 }, (_, i) => BigInt(i + 1) * 1000n);
    const tree = new MerkleTree(TREE_DEPTH, leaves);
    for (let i = 0; i < leaves.length; i++) {
      const p = tree.proof(i);
      expect(p.pathElements).toHaveLength(TREE_DEPTH);
      expect(verify(leaves[i] as bigint, i, p.pathElements)).toBe(tree.root);
    }
  });

  it('incremental inserts match a tree rebuilt from scratch', () => {
    const tree = new MerkleTree(5);
    const leaves: bigint[] = [];
    for (let i = 0; i < 9; i++) {
      leaves.push(randomFieldElement());
      tree.insert(leaves[i] as bigint);
      expect(tree.root).toBe(new MerkleTree(5, leaves).root);
    }
  });

  it('rejects inserts beyond capacity', () => {
    const tree = new MerkleTree(2, [1n, 2n, 3n, 4n]);
    expect(() => tree.insert(5n)).toThrow(RangeError);
  });
});

describe('ext data hash', () => {
  const ct = '0x01' as const;
  it('binds the recipient and every ciphertext', () => {
    const base = extDataHashOf({ recipient: zeroAddress, ciphertexts: [ct, ct, ct] });
    expect(base < FIELD_SIZE).toBe(true);
    expect(extDataHashOf({ recipient: '0x0000000000000000000000000000000000000001', ciphertexts: [ct, ct, ct] })).not.toBe(base);
    expect(extDataHashOf({ recipient: zeroAddress, ciphertexts: [ct, ct, '0x02'] })).not.toBe(base);
  });
});

describe('note encryption', () => {
  const privateKey = new Uint8Array(32).fill(7);
  const keys = { privateKey, publicKey: encryptionPublicKeyOf(privateKey) };

  it('round-trips and always has the same size', () => {
    const n = note({ amount: MAX_AMOUNT, token: (1n << 160n) - 1n, salt: randomFieldElement() });
    const ct = encryptNote(keys.publicKey, n);
    expect(ct.length).toBe(CIPHERTEXT_SIZE);
    expect(encryptNote(keys.publicKey, note({ amount: 0n })).length).toBe(CIPHERTEXT_SIZE);
    expect(decryptNote(keys, ct)).toEqual(n);
  });

  it('returns null for someone else or for tampered bytes', () => {
    const other = new Uint8Array(32).fill(9);
    const ct = encryptNote(encryptionPublicKeyOf(other), note());
    expect(decryptNote(keys, ct)).toBeNull();
    const mine = encryptNote(keys.publicKey, note());
    mine[100] = (mine[100] as number) ^ 1;
    expect(decryptNote(keys, mine)).toBeNull();
    expect(decryptNote(keys, new Uint8Array(10))).toBeNull();
  });
});

describe('channel signatures', () => {
  it('verify only for the signed hash and key', () => {
    const key = generateChannelKey();
    const pk = channelPublicKeyOf(key);
    const sig = signStateHash(key, 42n);
    expect(verifyStateSignature(pk, 42n, sig)).toBe(true);
    expect(verifyStateSignature(pk, 43n, sig)).toBe(false);
    expect(verifyStateSignature(channelPublicKeyOf(generateChannelKey()), 42n, sig)).toBe(false);
  });
});
