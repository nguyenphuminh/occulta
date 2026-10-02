import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { AppError } from '../../shared/errors/AppError.ts';
import { EnvelopeSchema, WalletDocumentSchema, type Envelope, type WalletDocument } from './wallet.schema.ts';

/** scrypt cost; the envelope records it so it can change without breaking old files. */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
}
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

/** A password-derived key, kept in memory only while the wallet is unlocked. */
export interface VaultKey {
  key: Uint8Array;
  kdf: KdfParams;
  salt: Uint8Array;
}

const random = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
};

export async function deriveVaultKey(password: string, kdf: KdfParams = DEFAULT_KDF, salt = random(16)): Promise<VaultKey> {
  const key = await scryptAsync(utf8ToBytes(password), salt, { ...kdf, dkLen: 32 });
  return { key, kdf, salt };
}

export function seal(vaultKey: VaultKey, doc: WalletDocument): string {
  const nonce = random(24);
  const plaintext = utf8ToBytes(JSON.stringify(doc));
  const envelope: Envelope = {
    format: 'occulta-wallet',
    version: 1,
    kdf: { name: 'scrypt', ...vaultKey.kdf, salt: `0x${bytesToHex(vaultKey.salt)}` },
    nonce: `0x${bytesToHex(nonce)}`,
    ciphertext: `0x${bytesToHex(xchacha20poly1305(vaultKey.key, nonce).encrypt(plaintext))}`,
  };
  return JSON.stringify(envelope);
}

export function parseEnvelope(content: string): Envelope {
  try {
    return EnvelopeSchema.parse(JSON.parse(content));
  } catch {
    throw new AppError(400, 'INVALID_WALLET_FILE', 'This is not an Occulta wallet file');
  }
}

/** Decrypts an envelope; a wrong password fails authentication and throws WRONG_PASSWORD. */
export async function open(content: string, password: string): Promise<{ doc: WalletDocument; vaultKey: VaultKey }> {
  const envelope = parseEnvelope(content);
  const { name: _name, salt, ...kdf } = envelope.kdf;
  const vaultKey = await deriveVaultKey(password, kdf, hexToBytes(salt.slice(2)));
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(vaultKey.key, hexToBytes(envelope.nonce.slice(2))).decrypt(hexToBytes(envelope.ciphertext.slice(2)));
  } catch {
    throw new AppError(401, 'WRONG_PASSWORD', 'Wrong password');
  }
  return { doc: WalletDocumentSchema.parse(JSON.parse(new TextDecoder().decode(plaintext))), vaultKey };
}
