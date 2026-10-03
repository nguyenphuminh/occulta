import { isAppError } from '@occulta/framework';
import { errorText } from '../../shared/ui.tsx';

/**
 * A channel being opened from this tab (BRD 2.2.14.8): it shows in the channel list while the other
 * side decides, so the rest of the wallet stays usable. It becomes the channel once the other side
 * accepts; a declined or failed one stays until the user dismisses it. Kept in this tab only: an open
 * in progress cannot continue after a reload or a lock anyway.
 */
export interface PendingOpen {
  /** Local id, also its address: #/channels/<id>. */
  id: string;
  accountId: string;
  networkId: string;
  peerId: string;
  token: bigint;
  amount: bigint;
  peerAmount: bigint;
  state: 'waiting' | 'declined' | 'failed';
  /** Why it failed; a decline needs no explanation. */
  error: string | null;
}

export type PendingOpenStart = Pick<PendingOpen, 'accountId' | 'networkId' | 'peerId' | 'token' | 'amount' | 'peerAmount'>;

export class PendingOpens {
  private items: PendingOpen[] = [];
  /** Why funding failed, by channel id, for channels accepted by the other side. */
  private readonly fundingErrors = new Map<string, string>();
  /** Channels accepted by the other side that this tab is still funding. */
  private readonly funding = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private next = 0;

  /**
   * Runs `open` in the background and returns the local id. `open` calls `accepted` once the channel
   * exists, which hands over to it: `onOpened` gets the channel's id. Funding goes on after that.
   */
  start(entry: PendingOpenStart, open: (accepted: (channelId: string) => void) => Promise<{ id: string }>, onOpened: (pendingId: string, channelId: string) => void): string {
    const id = `pending-${Date.now().toString(36)}-${(this.next++).toString(36)}`;
    let channelId: string | null = null;
    const handOver = (channel: string) => {
      if (channelId !== null || !this.has(id)) return;
      channelId = channel;
      this.funding.add(channel);
      this.items = this.items.filter((p) => p.id !== id);
      this.emit();
      onOpened(id, channel);
    };
    this.items = [...this.items, { ...entry, id, state: 'waiting', error: null }];
    this.emit();
    open(handOver).then(
      (record) => {
        if (channelId === null) handOver(record.id);
        this.funding.delete(record.id);
        this.emit(); // funded: the channel moved on
      },
      (err: unknown) => {
        const message = errorText(err);
        if (channelId !== null) {
          this.funding.delete(channelId);
          this.fundingErrors.set(channelId, message);
          this.emit();
          return;
        }
        if (!this.has(id)) return;
        const declined = isAppError(err) && err.code === 'OPEN_DECLINED';
        this.items = this.items.map((p) => (p.id === id ? { ...p, state: declined ? 'declined' : 'failed', error: declined ? null : message } : p));
        this.emit();
      },
    );
    return id;
  }

  /** Whether this tab is still funding a channel the other side accepted. */
  isFunding(channelId: string): boolean {
    return this.funding.has(channelId);
  }

  /** Why this tab could not fund a channel the other side accepted, if it could not. */
  fundingError(channelId: string): string | null {
    return this.fundingErrors.get(channelId) ?? null;
  }

  /** The active account's opens on the selected network, oldest first. */
  list(accountId: string, networkId: string): PendingOpen[] {
    return this.items.filter((p) => p.accountId === accountId && p.networkId === networkId);
  }

  get(id: string): PendingOpen | undefined {
    return this.items.find((p) => p.id === id);
  }

  dismiss(id: string): void {
    this.items = this.items.filter((p) => p.id !== id);
    this.emit();
  }

  /** On lock: nothing in progress can continue. */
  clear(): void {
    this.items = [];
    this.fundingErrors.clear();
    this.funding.clear();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private has(id: string): boolean {
    return this.items.some((p) => p.id === id);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
