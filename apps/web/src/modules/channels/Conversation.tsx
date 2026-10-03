import { useEffect, useRef, useState } from 'react';
import { balanceOf, sideOf, type ChannelRecord, type ChannelService } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, parseAmount, SYMBOL, tokenId, tokenName } from '../../shared/amounts.ts';
import { Avatar, BackIcon, EditIcon, SendIcon } from '../../shared/icons.tsx';
import { Button, ErrorNote, Modal, RelayedSubmit, useAction } from '../../shared/ui.tsx';
import { MAX_NICKNAME, setNickname } from './nicknames.ts';
import type { PendingOpen } from './pendingOpens.ts';
import { PENDING_TEXT, STATUS_TEXT, peerName } from './status.ts';
import { timelineOf } from './timeline.ts';

/** One channel as a conversation (BRD 2.2.8–2.2.10): balances, payments either way, pay, close or dispute. */
export function Conversation({ record, channels, names }: { record: ChannelRecord; channels: ChannelService; names: Record<string, string> }) {
  const { occulta, pendingOpens, refresh } = useApp();
  const network = occulta.network();
  const token = tokenName(record.token);
  const me = sideOf(record);
  const s = record.latest.state;
  const [amount, setAmount] = useState('');
  const [disputing, setDisputing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const rename = useAction(async () => {
    await setNickname(occulta, record.peer.peerId, name);
    setRenaming(false);
    refresh();
  });
  const pay = useAction(async () => {
    await channels.pay(record.id, parseAmount(token, amount) as bigint);
    setAmount('');
    refresh();
  });
  const dispute = useAction(async () => {
    await occulta.disputes.start(record.id, occulta.relayer());
    setDisputing(false);
    refresh();
  });
  const check = useAction(async () => {
    await occulta.tick();
    refresh();
  });
  const live = record.status === 'live';
  const funding = pendingOpens.fundingError(record.id);
  const entries = timelineOf(record);
  const timeline = useRef<HTMLOListElement>(null);
  // The newest payment stays in view, as in a chat.
  useEffect(() => {
    timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
  }, [entries.length]);
  return (
    <section className="conversation" aria-label="Channel" data-testid={`channel-${record.id}`}>
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/channels" aria-label="Back to channels">
          <BackIcon />
        </a>
        <Avatar seed={record.peer.peerId} size={40} />
        {renaming ? (
          <form
            className="rename"
            onSubmit={(e) => {
              e.preventDefault();
              void rename.perform();
            }}
          >
            <input aria-label="Nickname" value={name} maxLength={MAX_NICKNAME} autoFocus placeholder="Nickname" onChange={(e) => setName(e.target.value)} />
            <Button type="submit" className="primary small" busy={rename.busy}>
              Save
            </Button>
            <Button className="ghost small" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="conversation-title">
            <span className="conversation-name">
              <h2 className="peer-name truncate">{peerName(record.peer.peerId, names)}</h2>
              <button
                type="button"
                className="icon-button tiny"
                aria-label={names[record.peer.peerId] ? 'Rename' : 'Add a nickname'}
                onClick={() => {
                  setName(names[record.peer.peerId] ?? '');
                  setRenaming(true);
                }}
              >
                <EditIcon />
              </button>
            </span>
            <span className="muted small">{record.role === 'A' ? 'You opened it' : 'You were invited'}</span>
          </div>
        )}
        <span className={`pill status-${record.status}`}>{STATUS_TEXT[record.status]}</span>
      </header>

      <div className="channel-strip">
        <dl className="balance-strip">
          <div>
            <dt>Your balance</dt>
            <dd data-testid="channel-mine">{formatAmount(token, balanceOf(s, me))}</dd>
          </div>
          <div>
            <dt>Their balance</dt>
            <dd data-testid="channel-theirs">{formatAmount(token, balanceOf(s, me === 0 ? 1 : 0))}</dd>
          </div>
          <div>
            <dt>Closing fee</dt>
            <dd>{formatAmount(token, s.closingFee)}</dd>
          </div>
        </dl>

        <div className="channel-actions">
          {record.status === 'live' || record.status === 'closing' ? (
            <RelayedSubmit
              label="Close channel"
              className="secondary small"
              token={token}
              tokenId={tokenId(token, network)}
              relayer={() => occulta.relayer()}
              details={<p>Close cooperatively with the current balances. The closing fee becomes the relayer&apos;s current fee; any difference comes from your side.</p>}
              run={(relayer) => channels.close(record.id, relayer)}
              onDone={refresh}
            />
          ) : null}
          {['funding', 'live', 'closing'].includes(record.status) ? (
            <Button className="danger small" onClick={() => setDisputing(true)}>
              Close without the other side
            </Button>
          ) : null}
          {record.status === 'disputing' ? (
            <Button className="secondary small" busy={check.busy} onClick={() => void check.perform()}>
              Check dispute now
            </Button>
          ) : null}
        </div>
      </div>

      <ol className="timeline" ref={timeline}>
        {entries.map((entry, i) =>
          entry.kind === 'payment' ? (
            <li key={i} className={entry.outgoing ? 'bubble out' : 'bubble in'}>
              <span className="bubble-label">{entry.outgoing ? 'You paid' : 'You received'}</span>
              <strong>{formatAmount(token, entry.amount)}</strong>
              {entry.pending ? <span className="bubble-note">Waiting for the other side</span> : null}
            </li>
          ) : entry.kind === 'final' ? (
            <li key={i} className="event">
              Final balances agreed · you {formatAmount(token, entry.mine)}, them {formatAmount(token, entry.theirs)}
            </li>
          ) : (
            <li key={i} className="event">
              {entry.text}
            </li>
          ),
        )}
      </ol>
      {record.status === 'disputing' ? (
        <p className="notice">While your wallet is unlocked, it answers an old state with your latest one, finalizes after the deadline and reclaims what is yours.</p>
      ) : null}

      <ErrorNote error={pay.error ?? dispute.error ?? check.error ?? rename.error} />
      {record.status === 'opening' ? <ErrorNote error={funding && `Funding this channel failed: ${funding}`} /> : null}
      <div className="composer">
        <label className="composer-field">
          <span className="sr-only">Pay ({SYMBOL[token]})</span>
          <input
            aria-label={`Pay (${SYMBOL[token]})`}
            inputMode="decimal"
            value={amount}
            disabled={!live}
            placeholder={live ? `Amount in ${SYMBOL[token]}` : 'Payments open once the channel is live'}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <Button className="primary round" aria-label="Pay" busy={pay.busy} disabled={!live || parseAmount(token, amount) === null} onClick={() => void pay.perform()}>
          <SendIcon />
        </Button>
      </div>

      {disputing ? (
        <Modal title="Close without the other side">
          <p>This starts a public dispute with your latest state. It settles after the 7-day window. Use it only if the other side stopped answering.</p>
          <ErrorNote error={dispute.error} />
          <div className="stack">
            <Button className="danger wide" busy={dispute.busy} onClick={() => void dispute.perform()}>
              Start dispute
            </Button>
            <Button className="ghost wide" onClick={() => setDisputing(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

/**
 * An open waiting for the other side, laid out like its channel will be (BRD 2.2.14.8): the request,
 * then what became of it. Nothing leaves the shielded balance until the other side accepts.
 */
export function PendingConversation({ open, names }: { open: PendingOpen; names: Record<string, string> }) {
  const { pendingOpens } = useApp();
  const token = tokenName(open.token);
  const name = peerName(open.peerId, names);
  return (
    <section className="conversation" aria-label="Channel" data-testid="pending-open">
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/channels" aria-label="Back to channels">
          <BackIcon />
        </a>
        <Avatar seed={open.peerId} size={40} />
        <div className="conversation-title">
          <span className="conversation-name">
            <h2 className="peer-name truncate">{name}</h2>
          </span>
          <span className="muted small">You are opening it</span>
        </div>
        <span className={`pill status-${open.state === 'waiting' ? 'pending' : open.state}`}>{PENDING_TEXT[open.state]}</span>
      </header>

      <div className="channel-strip">
        <dl className="balance-strip">
          <div>
            <dt>You fund</dt>
            <dd>{formatAmount(token, open.amount)}</dd>
          </div>
          {open.peerAmount > 0n ? (
            <div>
              <dt>You asked them for</dt>
              <dd>{formatAmount(token, open.peerAmount)}</dd>
            </div>
          ) : null}
        </dl>
        {open.state === 'waiting' ? null : (
          <div className="channel-actions">
            <Button
              className="secondary small"
              onClick={() => {
                pendingOpens.dismiss(open.id);
                location.hash = '#/channels';
              }}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>

      <ol className="timeline">
        <li className="event">{open.peerAmount > 0n ? `You asked ${name} to open a channel` : `You are opening a channel with ${name}`}</li>
        {open.state === 'waiting' ? (
          <li className="event" aria-busy="true">
            <span className="spinner" aria-hidden="true" /> {open.peerAmount > 0n ? `Waiting for ${name} to accept` : `Reaching ${name}…`}
          </li>
        ) : (
          <>
            <li className="event">{open.state === 'declined' ? `${name} declined, or did not answer in time` : `The channel was not opened: ${open.error}`}</li>
            <li className="event">Nothing left your shielded balance.</li>
          </>
        )}
      </ol>

      <div className="composer">
        <label className="composer-field">
          <span className="sr-only">Pay ({SYMBOL[token]})</span>
          <input aria-label={`Pay (${SYMBOL[token]})`} disabled placeholder="Payments open once the channel is live" />
        </label>
        <Button className="primary round" aria-label="Pay" disabled>
          <SendIcon />
        </Button>
      </div>
    </section>
  );
}
