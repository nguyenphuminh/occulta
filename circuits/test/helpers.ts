import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import type { CircuitInput } from '@occulta/framework/protocol';

export type CircuitName = 'transfer' | 'finalize' | 'reclaim' | 'submit_state';

const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), '../build');
export const artifact = (name: CircuitName, ext: string): string => join(buildDir, name, `${name}.${ext}`);

/** True when the input produces a witness that satisfies every constraint of the circuit's R1CS. */
export async function satisfies(name: CircuitName, input: CircuitInput): Promise<boolean> {
  const wtns: snarkjs.MemFile = { type: 'mem' };
  try {
    await snarkjs.wtns.calculate(input, artifact(name, 'wasm'), wtns);
  } catch {
    return false;
  }
  return snarkjs.wtns.check(artifact(name, 'r1cs'), wtns);
}

export async function prove(name: CircuitName, input: CircuitInput) {
  return snarkjs.groth16.fullProve(input, artifact(name, 'wasm'), artifact(name, 'zkey'));
}

export function verificationKey(name: CircuitName): Record<string, unknown> & { nPublic: number } {
  return JSON.parse(readFileSync(artifact(name, 'vkey.json'), 'utf8'));
}

/** Names of the public signals in declaration order, read from the circuit's symbol file. */
export function publicSignalNames(name: CircuitName): string[] {
  const nPublic = verificationKey(name).nPublic;
  const byWire = new Map<number, string>();
  for (const line of readFileSync(artifact(name, 'sym'), 'utf8').split('\n')) {
    const [, wire, , symbol] = line.split(',');
    if (symbol?.startsWith('main.') && !symbol.slice(5).includes('.')) byWire.set(Number(wire), symbol.slice(5));
  }
  return Array.from({ length: nPublic }, (_, i) => byWire.get(i + 1) ?? `?${i + 1}`);
}
