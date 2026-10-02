import { concat, hexToBytes, keccak256, stringToHex, toHex, type Hex, type LocalAccount } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import {
  PAYOUT_DOMAIN,
  bytesToBigInt,
  encryptionPublicKeyOf,
  fieldToBytes,
  hash3,
  ownerTagOf,
  toField,
  type EncryptionKeyPair,
} from '../../shared/protocol/index.ts';

/** The fixed, Occulta-specific message whose signature seeds an account's pool keys (BRD 2.2.0). */
export const POOL_KEY_MESSAGE = 'Occulta pool keys v1\n\nThis signature derives your private Occulta keys. Only Occulta itself ever signs it.';

export interface PoolKeys {
  /** Proves ownership of notes and computes their nullifiers. */
  spendingSecret: bigint;
  ownerTag: bigint;
  encryption: EncryptionKeyPair;
  /** Seed for per-channel keys; never leaves the device. */
  seed: Hex;
}

/** Fresh per-channel material (BRD 2.2.7), derived from the account so it survives a reset. */
export interface ChannelSecrets {
  /** Its owner tag is both the payout tag and the refund tag of this channel. */
  tagSecret: bigint;
  /** EdDSA (BabyJubJub) key that signs this channel's states. */
  signingKey: Uint8Array;
}

/**
 * Derives an account's pool keys from its own signature of the fixed message. The wallet signs
 * deterministically, so the same account key always gives the same pool keys.
 */
export async function derivePoolKeys(account: LocalAccount): Promise<PoolKeys> {
  const signature = await account.signMessage({ message: POOL_KEY_MESSAGE });
  const seed = keccak256(signature);
  const spendingSecret = toField(BigInt(keccak256(concat([seed, stringToHex('spend')]))));
  const privateKey = hexToBytes(keccak256(concat([seed, stringToHex('encrypt')])));
  return {
    spendingSecret,
    ownerTag: ownerTagOf(spendingSecret),
    encryption: { privateKey, publicKey: encryptionPublicKeyOf(privateKey) },
    seed,
  };
}

export function channelSecrets(keys: PoolKeys, index: number): ChannelSecrets {
  return {
    tagSecret: hash3(PAYOUT_DOMAIN, keys.spendingSecret, BigInt(index)),
    signingKey: hexToBytes(keccak256(concat([keys.seed, stringToHex('channel'), toHex(index, { size: 4 })]))),
  };
}

// --- shielded address: "occ" + owner tag (32 bytes) + encryption public key (32) + checksum (4) ---

export interface ShieldedAddress {
  ownerTag: bigint;
  encryptionPublicKey: Uint8Array;
}

export function encodeShieldedAddress(address: ShieldedAddress): string {
  const body = concat([toHex(fieldToBytes(address.ownerTag)), toHex(address.encryptionPublicKey)]);
  return `occ${body.slice(2)}${keccak256(body).slice(2, 10)}`;
}

export function decodeShieldedAddress(text: string): ShieldedAddress {
  const value = text.trim();
  if (!/^occ[0-9a-f]{136}$/.test(value)) throw new AppError(400, 'INVALID_SHIELDED_ADDRESS', 'This is not an Occulta shielded address');
  const body = `0x${value.slice(3, 131)}` as Hex;
  if (keccak256(body).slice(2, 10) !== value.slice(131)) {
    throw new AppError(400, 'INVALID_SHIELDED_ADDRESS', 'The shielded address has a typo (checksum mismatch)');
  }
  const bytes = hexToBytes(body);
  return { ownerTag: bytesToBigInt(bytes.slice(0, 32)), encryptionPublicKey: bytes.slice(32) };
}

export const shieldedAddressOf = (keys: PoolKeys): string =>
  encodeShieldedAddress({ ownerTag: keys.ownerTag, encryptionPublicKey: keys.encryption.publicKey });
