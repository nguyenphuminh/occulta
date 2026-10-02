// Builds Groth16 proofs off the page's main thread (BRD 2.2.1: proofs are built on the user's
// device). Proving takes many seconds in a browser; on the main thread it would freeze the page and
// stop it answering libp2p's health checks, which drops its relayed connections.
import * as snarkjs from 'snarkjs';

export interface ProveRequest {
  id: number;
  base: string;
  circuit: string;
  input: Record<string, unknown>;
}

export type ProveReply = { id: number; proof: snarkjs.Groth16Proof; publicSignals: string[] } | { id: number; error: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<ProveRequest>) => void) | null; postMessage: (reply: ProveReply) => void };
const files = new Map<string, Promise<Uint8Array>>();

function load(url: string): Promise<Uint8Array> {
  let bytes = files.get(url);
  if (!bytes) {
    bytes = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`could not load ${url}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    files.set(url, bytes);
  }
  return bytes;
}

scope.onmessage = (event) => {
  const { id, base, circuit, input } = event.data;
  void Promise.all([load(`${base}/${circuit}.wasm`), load(`${base}/${circuit}.zkey`)])
    .then(([wasm, zkey]) => snarkjs.groth16.fullProve(input, wasm, zkey))
    .then(
      ({ proof, publicSignals }) => scope.postMessage({ id, proof, publicSignals }),
      (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
    );
};
