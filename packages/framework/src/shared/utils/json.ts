import { z } from 'zod';

/** Converts bigints to decimal strings so a value can be stored or sent as JSON. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** A bigint carried as a decimal string (or already a bigint). */
export const bigintString = z.union([z.bigint(), z.string().regex(/^\d+$/)]).transform((v) => BigInt(v));

export const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/) as z.ZodType<`0x${string}`>;
