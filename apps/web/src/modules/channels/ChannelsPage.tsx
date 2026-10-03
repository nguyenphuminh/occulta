import { balanceOf, isAppError, sideOf, type ChannelService } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, tokenName } from '../../shared/amounts.ts';
import { Avatar, ChannelsIcon, LinkIcon, PlusIcon } from '../../shared/icons.tsx';
import { Notice, Page } from '../../shared/ui.tsx';
import { Conversation } from './Conversation.tsx';
import { nicknames } from './nicknames.ts';
import { InviteDialog, OpenDialog } from './Panels.tsx';
import { STATUS_TEXT, peerName } from './status.ts';
import { timelineOf } from './timeline.ts';

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

/** BRD 2.2.6–2.2.10 on the website: channels as conversations, the product's main screen. */
export function ChannelsPage({ view }: { view: ChannelsView }) {
  const { occulta, version } = useApp();
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
  const selected = view.kind === 'channel' ? list.find((r) => r.id === view.id) : undefined;
  const hasFunds = [...occulta.pool.balances().values()].some((v) => v > 0n);
  return (
    <div className={view.kind === 'channel' ? 'channels has-detail' : 'channels'} data-version={version}>
      <section className="channel-list" aria-label="Your channels">
        <header className="page-head">
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
        {list.length === 0 ? (
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
            {list.map((r) => {
              const token = tokenName(r.token);
              return (
                <li key={r.id}>
                  <a className={selected?.id === r.id ? 'channel-item on' : 'channel-item'} href={`#/channels/${r.id}`} data-testid="channel-item">
                    <Avatar seed={r.peer.peerId} />
                    <span className="channel-item-main">
                      <span className="channel-item-top">
                        <strong className="truncate">{peerName(r.peer.peerId, names)}</strong>
                        <span className="muted small">{formatAmount(token, balanceOf(r.latest.state, sideOf(r)))}</span>
                      </span>
                      <span className="channel-item-bottom">
                        <span className="muted small truncate">{lastLine(channels, r.id)}</span>
                        <span className={`pill tiny status-${r.status}`}>{STATUS_TEXT[r.status]}</span>
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {view.kind === 'channel' ? (
        <div className="channel-detail">
          {selected ? (
            <Conversation key={selected.id} record={selected} channels={channels} names={names} />
          ) : (
            <div className="empty wide">
              <ChannelsIcon />
              <p>This channel is not in this account on this network.</p>
            </div>
          )}
        </div>
      ) : null}
      {view.kind === 'invite' ? <InviteDialog /> : null}
      {view.kind === 'open' ? <OpenDialog key={view.invite} initialInvite={view.invite} /> : null}
    </div>
  );
}
