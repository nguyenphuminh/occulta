import type { CircuitName, ProofResult, ProverPort } from '@occulta/framework';
import { toEvmProof, type CircuitInput } from '@occulta/framework/protocol';
import type { ProveReply, ProveRequest } from './prover.worker.ts';

/** The framework's prover, running snarkjs in a Web Worker so the page stays responsive. */
export class WorkerProver implements ProverPort {
  private readonly base: string;
  private readonly worker: Worker;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (r: ProofResult) => void; reject: (e: Error) => void }>();

  /** `base`: where the proving files are served, e.g. https://wallet.example/artifacts. */
  constructor(base: string) {
    this.base = base;
    this.worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<ProveReply>) => {
      const reply = event.data;
      const waiter = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      if (!waiter) return;
      if ('error' in reply) waiter.reject(new Error(`Could not build the proof: ${reply.error}`));
      else waiter.resolve({ proof: toEvmProof(reply.proof), signals: reply.publicSignals.map(BigInt) });
    };
    this.worker.onerror = (event) => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error(`The prover stopped: ${event.message}`));
      this.waiting.clear();
    };
  }

  prove(circuit: CircuitName, input: CircuitInput): Promise<ProofResult> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const request: ProveRequest = { id, base: this.base, circuit, input };
      this.worker.postMessage(request);
    });
  }
}
