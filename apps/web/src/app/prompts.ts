import type { OpenRequest } from '@occulta/framework';

export type Prompt =
  | { kind: 'approve-open'; request: OpenRequest }
  | { kind: 'confirm-payment'; channelId: string; token: bigint; amount: bigint };

type OpenPrompt = Extract<Prompt, { kind: 'approve-open' }>;

export interface Asked<P extends Prompt = Prompt> {
  id: string;
  prompt: P;
  /** When an unanswered question counts as "no" (epoch ms), if it has a limit. */
  deadline: number | null;
  /** The user closed its dialog to answer later, from the channel list (channel requests only). */
  hidden: boolean;
  /** An accepted channel request, until its channel is saved. */
  joining: boolean;
}

type Pending = Asked & { resolve: (answer: boolean) => void };

/**
 * Questions the framework asks the user while it works: confirming an outgoing channel payment
 * (BRD 2.2.8) and approving a channel that asks for the user's money (BRD 2.2.7, 2.2.14.9). The
 * dialog shows one at a time; a channel request can also be answered from the channel list.
 */
export class Prompts {
  private queue: Pending[] = [];
  /** Channel requests that ended without a channel: declined or not answered in time. */
  private readonly ended = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private next = 0;

  /** Asks the user; an unanswered question counts as "no" after `timeoutMs`. */
  ask(prompt: Prompt, timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      const pending: Pending = { id: `prompt-${this.next++}`, prompt, deadline: timeoutMs ? Date.now() + timeoutMs : null, hidden: false, joining: false, resolve };
      this.queue = [...this.queue, pending];
      this.emit();
      if (timeoutMs) setTimeout(() => this.expire(pending.id), timeoutMs);
    });
  }

  /** The question for the dialog: the oldest one still unanswered and not put aside. */
  current(): Asked | null {
    return this.queue.find((p) => !p.hidden && !p.joining) ?? null;
  }

  /** Channel requests still waiting for an answer, or accepted and waiting for their channel. */
  requests(): Asked<OpenPrompt>[] {
    return this.queue.filter((p): p is Pending & Asked<OpenPrompt> => p.prompt.kind === 'approve-open');
  }

  /** Whether the request for this channel ended without the channel. */
  hasEnded(channelId: string): boolean {
    return this.ended.has(channelId);
  }

  answer(id: string, answer: boolean): void {
    const pending = this.queue.find((p) => p.id === id);
    if (!pending || pending.joining) return;
    pending.resolve(answer);
    if (answer && pending.prompt.kind === 'approve-open') {
      this.queue = this.queue.map((p) => (p === pending ? { ...p, joining: true } : p));
    } else {
      this.remove(pending, answer);
    }
    this.emit();
  }

  /** Closes a channel request's dialog; it stays in the channel list until answered or out of time. */
  hide(id: string): void {
    this.queue = this.queue.map((p) => (p.id === id && p.prompt.kind === 'approve-open' ? { ...p, hidden: true } : p));
    this.emit();
  }

  /** The channel of an accepted request is saved: the channel takes the request's place. */
  joined(channelId: string): void {
    this.queue = this.queue.filter((p) => p.prompt.kind !== 'approve-open' || p.prompt.request.channelId !== channelId);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** At the deadline: an unanswered question counts as "no"; an accepted request that never joined is dropped. */
  private expire(id: string): void {
    const pending = this.queue.find((p) => p.id === id);
    if (!pending) return;
    if (!pending.joining) pending.resolve(false);
    this.remove(pending, pending.joining);
    this.emit();
  }

  private remove(pending: Pending, accepted: boolean): void {
    this.queue = this.queue.filter((p) => p !== pending);
    if (!accepted && pending.prompt.kind === 'approve-open') this.ended.add(pending.prompt.request.channelId);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
