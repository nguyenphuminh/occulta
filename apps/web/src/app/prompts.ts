import type { OpenRequest } from '@occulta/framework';

export type Prompt =
  | { kind: 'approve-open'; request: OpenRequest }
  | { kind: 'confirm-payment'; channelId: string; token: bigint; amount: bigint };

type Pending = { prompt: Prompt; resolve: (answer: boolean) => void };

/**
 * Questions the framework asks the user while it works: confirming an outgoing channel payment
 * (BRD 2.2.8) and approving a channel that asks for the user's money (BRD 2.2.7). One at a time.
 */
export class Prompts {
  private queue: Pending[] = [];
  private readonly listeners = new Set<() => void>();

  /** Asks the user; an unanswered question counts as "no" after `timeoutMs`. */
  ask(prompt: Prompt, timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      const pending: Pending = { prompt, resolve };
      this.queue.push(pending);
      this.emit();
      if (timeoutMs) setTimeout(() => this.settle(pending, false), timeoutMs);
    });
  }

  current(): Prompt | null {
    return this.queue[0]?.prompt ?? null;
  }

  answer(answer: boolean): void {
    const first = this.queue[0];
    if (first) this.settle(first, answer);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(pending: Pending, answer: boolean): void {
    if (!this.queue.includes(pending)) return;
    this.queue = this.queue.filter((p) => p !== pending);
    pending.resolve(answer);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
