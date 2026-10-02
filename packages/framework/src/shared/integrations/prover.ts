import * as snarkjs from 'snarkjs';
import { toEvmProof, type CircuitInput, type EvmProof } from '../protocol/index.ts';

export type CircuitName = 'transfer' | 'finalize' | 'reclaim' | 'submit_state';

/** Where a host keeps the circuits' proving files: a folder on disk, or URLs on the website. */
export type ArtifactLoader = (circuit: CircuitName) => Promise<{ wasm: string | Uint8Array; zkey: string | Uint8Array }>;

export interface ProofResult {
  proof: EvmProof;
  signals: bigint[];
}

/** Groth16 proving with snarkjs, on the user's own device (BRD 2.2.1). */
export class Prover {
  private readonly load: ArtifactLoader;

  constructor(load: ArtifactLoader) {
    this.load = load;
  }

  async prove(circuit: CircuitName, input: CircuitInput): Promise<ProofResult> {
    const { wasm, zkey } = await this.load(circuit);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
    return { proof: toEvmProof(proof), signals: publicSignals.map(BigInt) };
  }
}

/** Node: proving files in a folder (packages/framework/artifacts after `npm run setup`). */
export const fileArtifacts =
  (dir: string): ArtifactLoader =>
  async (circuit) => ({ wasm: `${dir}/${circuit}.wasm`, zkey: `${dir}/${circuit}.zkey` });

/** Browser: proving files fetched once from a base URL and kept in memory. */
export function urlArtifacts(baseUrl: string): ArtifactLoader {
  const cache = new Map<string, Promise<Uint8Array>>();
  const fetchBytes = (url: string): Promise<Uint8Array> => {
    let bytes = cache.get(url);
    if (!bytes) {
      bytes = fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`could not load ${url}`);
        return new Uint8Array(await r.arrayBuffer());
      });
      cache.set(url, bytes);
    }
    return bytes;
  };
  return async (circuit) => ({ wasm: await fetchBytes(`${baseUrl}/${circuit}.wasm`), zkey: await fetchBytes(`${baseUrl}/${circuit}.zkey`) });
}
