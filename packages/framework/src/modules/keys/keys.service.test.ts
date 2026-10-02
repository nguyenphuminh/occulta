import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { FIELD_SIZE, decryptNote, encryptNote, ownerTagOf } from '../../shared/protocol/index.ts';
import { channelSecrets, decodeShieldedAddress, derivePoolKeys, shieldedAddressOf } from './keys.service.ts';

const KEY_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('pool keys', () => {
  it('are the same every time for the same account key, and differ between accounts', async () => {
    const a1 = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const a2 = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const b = await derivePoolKeys(privateKeyToAccount(KEY_B));
    expect(a1.spendingSecret).toBe(a2.spendingSecret);
    expect(a1.encryption.publicKey).toEqual(a2.encryption.publicKey);
    expect(a1.spendingSecret).not.toBe(b.spendingSecret);
    expect(a1.spendingSecret < FIELD_SIZE).toBe(true);
    expect(a1.ownerTag).toBe(ownerTagOf(a1.spendingSecret));
  });

  it('decrypt notes sent to the account', async () => {
    const keys = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const note = { amount: 5n, token: 0n, ownerTag: keys.ownerTag, salt: 9n };
    expect(decryptNote(keys.encryption, encryptNote(keys.encryption.publicKey, note))).toEqual(note);
  });

  it('give each channel fresh, deterministic secrets', async () => {
    const keys = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const c0 = channelSecrets(keys, 0);
    const c1 = channelSecrets(keys, 1);
    expect(channelSecrets(keys, 0)).toEqual(c0);
    expect(c0.tagSecret).not.toBe(c1.tagSecret);
    expect(c0.signingKey).not.toEqual(c1.signingKey);
    expect(ownerTagOf(c0.tagSecret)).not.toBe(keys.ownerTag);
  });
});

describe('shielded address', () => {
  it('round-trips and catches typos', async () => {
    const keys = await derivePoolKeys(privateKeyToAccount(KEY_A));
    const text = shieldedAddressOf(keys);
    expect(text).toMatch(/^occ[0-9a-f]{136}$/);
    const decoded = decodeShieldedAddress(text);
    expect(decoded.ownerTag).toBe(keys.ownerTag);
    expect(decoded.encryptionPublicKey).toEqual(keys.encryption.publicKey);
    const typo = `${text.slice(0, 10)}${text[10] === 'a' ? 'b' : 'a'}${text.slice(11)}`;
    expect(() => decodeShieldedAddress(typo)).toThrow(/typo/);
    expect(() => decodeShieldedAddress('0x1234')).toThrow(/not an Occulta shielded address/);
  });
});
