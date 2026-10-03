import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenRequest } from '@occulta/framework';
import { Prompts } from './prompts.ts';

const request = (channelId: string): OpenRequest => ({ channelId, peerId: 'peer', token: 0n, amount: 3n, peerAmount: 2n, window: 604_800n, closingFee: 1n });
const payment = { kind: 'confirm-payment', channelId: 'c', token: 0n, amount: 1n } as const;
const settle = () => Promise.resolve().then(() => undefined);

describe('questions to the user', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the oldest question first; each answer goes to its own question', async () => {
    const prompts = new Prompts();
    const first = prompts.ask(payment);
    const second = prompts.ask({ kind: 'approve-open', request: request('c1') }, 50_000);
    const [a, b] = [prompts.current(), prompts.requests()[0]];
    expect(a?.prompt).toEqual(payment);
    prompts.answer(b!.id, false); // answered from the channel list while the payment is on screen
    await expect(second).resolves.toBe(false);
    expect(prompts.current()?.id).toBe(a!.id);
    prompts.answer(a!.id, true);
    await expect(first).resolves.toBe(true);
    expect(prompts.current()).toBeNull();
  });

  it('keeps a channel request whose dialog was closed in the list, to answer later', async () => {
    const prompts = new Prompts();
    const answer = prompts.ask({ kind: 'approve-open', request: request('c1') }, 50_000);
    const asked = prompts.current()!;
    expect(asked.deadline).toBe(Date.now() + 50_000);
    prompts.hide(asked.id);
    expect(prompts.current()).toBeNull();
    expect(prompts.requests()).toMatchObject([{ id: asked.id, hidden: true, joining: false }]);
    vi.advanceTimersByTime(30_000);
    prompts.answer(asked.id, true);
    await expect(answer).resolves.toBe(true);
  });

  it('holds an accepted request until its channel is saved, then lets the channel take its place', async () => {
    const prompts = new Prompts();
    const answer = prompts.ask({ kind: 'approve-open', request: request('c1') }, 50_000);
    prompts.answer(prompts.current()!.id, true);
    await expect(answer).resolves.toBe(true);
    expect(prompts.requests()).toMatchObject([{ joining: true }]);
    expect(prompts.current()).toBeNull(); // never shown in the dialog again
    prompts.answer(prompts.requests()[0]!.id, false); // too late to change the answer
    expect(prompts.requests()).toHaveLength(1);
    prompts.joined('c1');
    expect(prompts.requests()).toEqual([]);
    expect(prompts.hasEnded('c1')).toBe(false);
  });

  it('counts a request nobody answers as declined at the deadline, and remembers that it ended', async () => {
    const prompts = new Prompts();
    const changes = vi.fn();
    prompts.subscribe(changes);
    const answer = prompts.ask({ kind: 'approve-open', request: request('c1') }, 50_000);
    prompts.hide(prompts.current()!.id);
    vi.advanceTimersByTime(50_000);
    await expect(answer).resolves.toBe(false);
    expect(prompts.requests()).toEqual([]);
    expect(prompts.hasEnded('c1')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(3); // asked, hidden, ended
  });

  it('remembers a declined request; drops an accepted one that never joined at the deadline', async () => {
    const prompts = new Prompts();
    void prompts.ask({ kind: 'approve-open', request: request('c1') }, 50_000);
    prompts.answer(prompts.current()!.id, false);
    expect(prompts.hasEnded('c1')).toBe(true);

    void prompts.ask({ kind: 'approve-open', request: request('c2') }, 50_000);
    prompts.answer(prompts.current()!.id, true);
    vi.advanceTimersByTime(50_000);
    await settle();
    expect(prompts.requests()).toEqual([]);
    expect(prompts.hasEnded('c2')).toBe(false);
  });

  it('never puts a payment confirmation aside: it is not a channel request', () => {
    const prompts = new Prompts();
    void prompts.ask(payment);
    const asked = prompts.current()!;
    prompts.hide(asked.id);
    expect(prompts.current()?.id).toBe(asked.id);
    expect(prompts.requests()).toEqual([]);
  });
});
