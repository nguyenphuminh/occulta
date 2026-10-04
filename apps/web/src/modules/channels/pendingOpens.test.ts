import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@occulta/framework';
import { PendingOpens, type PendingOpenStart } from './pendingOpens.ts';

const entry: PendingOpenStart = { accountId: 'acct', networkId: 'net', peerId: 'peer', token: 0n, amount: 3n, peerAmount: 2n };

/** An open the test finishes when it wants to, like a peer that answers later. */
function deferred() {
  let resolve!: (r: { id: string }) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<{ id: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('channel opens in progress', () => {
  it('shows a request at once, then hands over to the channel as soon as the other side accepts', async () => {
    const store = new PendingOpens();
    const open = deferred();
    let accepted!: (channelId: string) => void;
    const onOpened = vi.fn();
    const changes = vi.fn();
    store.subscribe(changes);
    const id = store.start(
      entry,
      (onAccepted) => {
        accepted = onAccepted;
        return open.promise;
      },
      onOpened,
    );
    expect(store.list('acct', 'net')).toEqual([{ ...entry, id, state: 'waiting', error: null }]);
    expect(changes).toHaveBeenCalledTimes(1);

    accepted('channel-1');
    expect(store.list('acct', 'net')).toEqual([]);
    expect(onOpened).toHaveBeenCalledWith(id, 'channel-1');
    expect(changes).toHaveBeenCalledTimes(2);
    expect(store.channelFor(id)).toBe('channel-1'); // the request's address still leads to its channel

    // Funded: the channel moved on, so the page redraws; nothing is handed over twice.
    open.resolve({ id: 'channel-1' });
    await settle();
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(3);
    expect(store.fundingError('channel-1')).toBeNull();
  });

  it('hands over when the open finishes, if it never said the channel was accepted', async () => {
    const store = new PendingOpens();
    const open = deferred();
    const onOpened = vi.fn();
    const id = store.start(entry, () => open.promise, onOpened);
    open.resolve({ id: 'channel-1' });
    await settle();
    expect(store.get(id)).toBeUndefined();
    expect(onOpened).toHaveBeenCalledWith(id, 'channel-1');
  });

  it('keeps why funding failed for a channel the other side accepted', async () => {
    const store = new PendingOpens();
    const open = deferred();
    const id = store.start(
      entry,
      (accepted) => {
        accepted('channel-1');
        return open.promise;
      },
      vi.fn(),
    );
    open.reject(new AppError(503, 'RELAYER_UNREACHABLE', 'The relayer is not reachable'));
    await settle();
    expect(store.get(id)).toBeUndefined();
    expect(store.fundingError('channel-1')).toBe('The relayer is not reachable');
    store.clear();
    expect(store.fundingError('channel-1')).toBeNull();
  });

  it('keeps a declined request, without an error, until it is dismissed', async () => {
    const store = new PendingOpens();
    const open = deferred();
    const id = store.start(entry, () => open.promise, vi.fn());
    open.reject(new AppError(403, 'OPEN_DECLINED', 'The other party declined this channel'));
    await settle();
    expect(store.get(id)).toMatchObject({ state: 'declined', error: null });
    store.dismiss(id);
    expect(store.get(id)).toBeUndefined();
  });

  it('keeps a failed request with the reason', async () => {
    const store = new PendingOpens();
    const open = deferred();
    const id = store.start(entry, () => open.promise, vi.fn());
    open.reject(new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now'));
    await settle();
    expect(store.get(id)).toMatchObject({ state: 'failed', error: 'The other party is not reachable right now' });
  });

  it('lists only the active account’s requests on the selected network, and forgets everything on lock', () => {
    const store = new PendingOpens();
    const never = () => new Promise<{ id: string }>(() => undefined);
    const mine = store.start(entry, never, vi.fn());
    store.start({ ...entry, accountId: 'other' }, never, vi.fn());
    store.start({ ...entry, networkId: 'elsewhere' }, never, vi.fn());
    expect(store.list('acct', 'net').map((p) => p.id)).toEqual([mine]);
    store.clear();
    expect(store.list('acct', 'net')).toEqual([]);
  });

  it('ignores an answer that arrives after the request was dismissed or forgotten', async () => {
    const store = new PendingOpens();
    const open = deferred();
    const onOpened = vi.fn();
    const id = store.start(entry, () => open.promise, onOpened);
    store.dismiss(id);
    open.resolve({ id: 'channel-1' });
    await settle();
    expect(onOpened).not.toHaveBeenCalled();
    expect(store.list('acct', 'net')).toEqual([]);
  });
});
