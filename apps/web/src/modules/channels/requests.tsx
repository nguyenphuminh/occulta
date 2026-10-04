import { useEffect, useState } from 'react';
import { quotedFee, type OpenRequest } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import type { Asked, Prompt } from '../../app/prompts.ts';
import { formatAmount, tokenName } from '../../shared/amounts.ts';
import { Avatar, BackIcon } from '../../shared/icons.tsx';
import { Button, ErrorNote, Field, Notice, useAction, useLoad } from '../../shared/ui.tsx';
import { MAX_NICKNAME, setNickname } from './nicknames.ts';
import { peerName } from './status.ts';

export type ChannelRequest = Asked<Extract<Prompt, { kind: 'approve-open' }>>;

/** Whole seconds until `deadline`, counting down once a second. */
export function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** What the request proposes, in one sentence. */
export function requestTerms(request: OpenRequest): string {
  const token = tokenName(request.token);
  return `They fund ${formatAmount(token, request.amount)} and ask you to fund ${formatAmount(token, request.peerAmount)}`;
}

/** BRD 2.2.7: the answer to a channel request, from its dialog or its chat. The user can name the peer then. */
export function RequestAnswer({ asked }: { asked: ChannelRequest }) {
  const { occulta, prompts } = useApp();
  const { request } = asked.prompt;
  const token = tokenName(request.token);
  const [nickname, setNicknameText] = useState('');
  const shielded = occulta.pool.balances().get(request.token) ?? 0n;
  // Funding is a transfer of its own: the relayer's fee comes on top of what they ask for.
  const fee = useLoad(async () => quotedFee(await occulta.relayer().info(), request.token), request.channelId);
  const short = fee.data !== null && shielded < request.peerAmount + fee.data;
  const accept = useAction(async () => {
    if (nickname.trim()) await setNickname(occulta, request.peerId, nickname);
    prompts.answer(asked.id, true);
  });
  return (
    <>
      <Field label="Nickname for them (optional)" hint="Only you see it. You can change it later.">
        <input value={nickname} maxLength={MAX_NICKNAME} placeholder="e.g. Bob" onChange={(e) => setNicknameText(e.target.value)} />
      </Field>
      {short ? (
        <Notice tone="warn">
          Your shielded balance has {formatAmount(token, shielded)}, less than the {formatAmount(token, request.peerAmount)} they ask you to fund plus the relayer fee of{' '}
          {formatAmount(token, fee.data as bigint)}.
        </Notice>
      ) : null}
      <ErrorNote error={fee.error ?? accept.error} />
      <div className="stack">
        <Button className="primary wide" busy={accept.busy} disabled={short || fee.data === null} onClick={() => void accept.perform()}>
          Accept and fund
        </Button>
        <Button className="ghost wide" onClick={() => prompts.answer(asked.id, false)}>
          Decline
        </Button>
      </div>
    </>
  );
}

/**
 * A channel request as its own conversation (BRD 2.2.14.9), for answering after its dialog was
 * closed, within the time the other side waits. Once accepted it gives way to the channel.
 */
export function RequestConversation({ asked, names }: { asked: ChannelRequest; names: Record<string, string> }) {
  const { request } = asked.prompt;
  const token = tokenName(request.token);
  const secondsLeft = useSecondsLeft(asked.deadline);
  return (
    <section className="conversation" aria-label="Channel" data-testid="channel-request">
      <header className="conversation-head">
        <a className="icon-button only-narrow" href="#/channels" aria-label="Back to channels">
          <BackIcon />
        </a>
        <Avatar seed={request.peerId} size={40} />
        <div className="conversation-title">
          <span className="conversation-name">
            <h2 className="peer-name truncate">{peerName(request.peerId, names)}</h2>
          </span>
          <span className="muted small">Wants to open a channel with you</span>
        </div>
        <span className="pill status-pending">{asked.joining ? 'Joining' : 'Request'}</span>
      </header>

      <div className="channel-strip">
        <dl className="balance-strip">
          <div>
            <dt>They fund</dt>
            <dd>{formatAmount(token, request.amount)}</dd>
          </div>
          <div>
            <dt>They ask you for</dt>
            <dd>{formatAmount(token, request.peerAmount)}</dd>
          </div>
          <div>
            <dt>Closing fee</dt>
            <dd>{formatAmount(token, request.closingFee)}, paid by them</dd>
          </div>
        </dl>
      </div>

      <ol className="timeline">
        <li className="event">
          {requestTerms(request)} · dispute window {Number(request.window) / 86_400} days
        </li>
        {asked.joining ? (
          <li className="event" aria-busy="true">
            <span className="spinner" aria-hidden="true" /> Joining the channel…
          </li>
        ) : (
          <li className="event">{secondsLeft} s left to answer</li>
        )}
      </ol>

      {asked.joining ? null : (
        <div className="request-answer">
          <RequestAnswer asked={asked} />
        </div>
      )}
    </section>
  );
}
