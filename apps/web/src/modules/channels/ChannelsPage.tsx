import { balanceOf, isAppError, sideOf, type ChannelService } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, tokenName } from '../../shared/amounts.ts';
import { Avatar, ChannelsIcon, LinkIcon, PlusIcon } from '../../shared/icons.tsx';
import { Notice, Page } from '../../shared/ui.tsx';
import { Conversation, PendingConversation } from './Conversation.tsx';
import { nicknames } from './nicknames.ts';
import { InviteDialog, OpenDialog } from './Panels.tsx';
import type { PendingOpen } from './pendingOpens.ts';
import { RequestConversation } from './requests.tsx';
import { PENDING_TEXT, STATUS_TEXT, peerName } from './status.ts';
import { timelineOf } from './timeline.ts';

/** Channels the other side could try to close with an old balance, which the wallet answers only while open. */
const OPEN_STATUSES: readonly string[] = ['funding', 'live', 'closing', 'disputing'];

/** What the channels screen shows: the list alone, a channel beside it, or a dialog over it. */
export type ChannelsView = { kind: 'none' } | { kind: 'channel'; id: string } | { kind: 'invite' } | { kind: 'open'; invite: string };

function lastLine(channels: ChannelService, id: string): string {
  const r = channels.get(id);
  const entry = timelineOf(r).at(-1);
  const token = tokenName(r.token);
  if (!entry) return '';
  if (entry.kind === 'payment') return `${entry.outgoing ? 'You paid' : 'You received'} ${formatAmount(token, entry.amount)}`;
  if (entry.kind === 'final') return 'Final balances agreed';
  return entry.text;
}

function pendingLine(p: PendingOpen): string {
  if (p.state === 'declined') return 'Declined, or no answer in time';
  if (p.state === 'failed') return 'Could not open the channel';
  return p.peerAmount > 0n ? 'Waiting for them to accept' : 'Reaching them…';
}

interface ItemProps {
  id: string;
  on: boolean;
  peerId: string;
  names: Record<string, string>;
  amount: string;
  line: string;
  status: string;
  statusText: string;
}

/** One row of the list: who, this side's amount, the latest line and the status. */
function ChannelItem({ id, on, peerId, names, amount, line, status, statusText }: ItemProps) {
  return (
    <li>
      <a className={on ? 'channel-item on' : 'channel-item'} href={`#/channels/${id}`} data-testid="channel-item">
        <Avatar seed={peerId} />
        <span className="channel-item-main">
          <span className="channel-item-top">
            <strong className="truncate">{peerName(peerId, names)}</strong>
            <span className="muted small">{amount}</span>
          </span>
          <span className="channel-item-bottom">
            <span className="muted small truncate">{line}</span>
            <span className={`pill tiny status-${status}`}>{statusText}</span>
          </span>
        </span>
      </a>
    </li>
  );
}

/**
 * BRD 2.2.6–2.2.10 on the website, laid out like a messaging app: the list of channels beside the
 * open one, both the full height of the screen; on phones the list, then the channel on its own.
 */
export function ChannelsPage({ view }: { view: ChannelsView }) {
  const { occulta, prompts, pendingOpens, version } = useApp();
  let channels: ChannelService;
  try {
    channels = occulta.channels;
  } catch (err) {
    if (isAppError(err) && err.code === 'NO_RELAY') {
      return (
        <Page title="Channels">
          <Notice tone="warn">Channels need a libp2p relay. Add one in Settings for this network.</Notice>
        </Page>
      );
    }
    throw err;
  }
  const names = nicknames(occulta);
  const list = [...channels.list()].reverse();
  // Channel requests to answer, then opens waiting for the other side, newest first, above the channels (BRD 2.2.14.8–9).
  const requests = [...prompts.requests()].reverse();
  const pending = [...pendingOpens.list(occulta.wallet.activeAccount().id, occulta.network().id)].reverse();
  const selected = view.kind === 'channel' ? list.find((r) => r.id === view.id) : undefined;
  const selectedRequest = view.kind === 'channel' ? requests.find((r) => r.prompt.request.channelId === view.id) : undefined;
  const selectedPending = view.kind === 'channel' ? pending.find((p) => p.id === view.id) : undefined;
  const hasFunds = [...occulta.pool.balances().values()].some((v) => v > 0n);
  const hasOpenChannels = list.some((r) => OPEN_STATUSES.includes(r.status));
  return (
    <div className={view.kind === 'channel' ? 'channels has-detail' : 'channels'} data-version={version}>
      <section className="channel-list" aria-label="Your channels">
        <header className="channel-list-head">
          <h1>Channels</h1>
          <div className="page-actions">
            <a className="pill-link" href="#/channels/invite">
              <LinkIcon /> Invite
            </a>
            <a className="pill-link primary" href="#/channels/new">
              <PlusIcon /> Open channel
            </a>
          </div>
        </header>
        {hasOpenChannels ? (
          // BRD 2.2.14: there is no watchtower yet, so the wallet must be opened within each dispute window.
          <p className="notice channel-reminder" role="note">
            Open Occulta at least every few days while you have open channels. If the other side tries to close with an old balance, your wallet has 7 days to answer, and it can only answer while it is open.
          </p>
        ) : null}
        {list.length === 0 && pending.length === 0 && requests.length === 0 ? (
          <div className="empty">
            <ChannelsIcon />
            <p>No channels yet.</p>
            <p className="muted small">Share your invite so someone can open a channel with you, or open one with their invite. Payments in a channel are instant and private.</p>
            {hasFunds ? null : (
              <p className="small">
                To fund a channel you open, first <a href="#/deposit">deposit into your shielded balance</a>.
              </p>
            )}
          </div>
        ) : (
          <ul className="channel-items">
            {requests.map((r) => (
              <ChannelItem
                key={r.id}
                id={r.prompt.request.channelId}
                on={selectedRequest?.id === r.id}
                peerId={r.prompt.request.peerId}
                names={names}
                amount={formatAmount(tokenName(r.prompt.request.token), r.prompt.request.peerAmount)}
                line={r.joining ? 'Joining the channel…' : 'Wants to open a channel with you'}
                status="pending"
                statusText={r.joining ? 'Joining' : 'Request'}
              />
            ))}
            {pending.map((p) => (
              <ChannelItem
                key={p.id}
                id={p.id}
                on={selectedPending?.id === p.id}
                peerId={p.peerId}
                names={names}
                amount={formatAmount(tokenName(p.token), p.amount)}
                line={pendingLine(p)}
                status={p.state === 'waiting' ? 'pending' : p.state}
                statusText={PENDING_TEXT[p.state]}
              />
            ))}
            {list.map((r) => (
              <ChannelItem
                key={r.id}
                id={r.id}
                on={selected?.id === r.id}
                peerId={r.peer.peerId}
                names={names}
                amount={formatAmount(tokenName(r.token), balanceOf(r.latest.state, sideOf(r)))}
                line={lastLine(channels, r.id)}
                status={r.status}
                statusText={STATUS_TEXT[r.status]}
              />
            ))}
          </ul>
        )}
      </section>
      <div className="channel-detail">
        {selected ? (
          <Conversation key={selected.id} record={selected} channels={channels} names={names} />
        ) : selectedRequest ? (
          <RequestConversation key={selectedRequest.id} asked={selectedRequest} names={names} />
        ) : selectedPending ? (
          <PendingConversation key={selectedPending.id} open={selectedPending} names={names} />
        ) : (
          <div className="chat-placeholder">
            <span className="chat-placeholder-icon">
              <ChannelsIcon />
            </span>
            {view.kind === 'channel' ? (
              <p>{prompts.hasEnded(view.id) ? 'This channel request ended: it was declined or not answered in time.' : 'This channel is not in this account on this network.'}</p>
            ) : (
              <>
                <h2>Your channels</h2>
                <p className="muted">Pick a channel to see its payments, or start one: payments in a channel are instant and private.</p>
                <div className="row">
                  <a className="pill-link primary" href="#/channels/new">
                    Open a channel
                  </a>
                  <a className="pill-link" href="#/channels/invite">
                    Share your invite
                  </a>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {view.kind === 'invite' ? <InviteDialog /> : null}
      {view.kind === 'open' ? <OpenDialog key={view.invite} initialInvite={view.invite} /> : null}
    </div>
  );
}
