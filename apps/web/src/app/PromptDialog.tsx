import { useState } from 'react';
import { formatAmount, tokenName } from '../shared/amounts.ts';
import { Button, ErrorNote, Field, Modal, useAction } from '../shared/ui.tsx';
import { MAX_NICKNAME, nicknames, peerName, setNickname } from '../modules/channels/index.ts';
import { useApp } from './context.ts';
import type { Prompt } from './prompts.ts';

type PaymentPrompt = Extract<Prompt, { kind: 'confirm-payment' }>;
type OpenPrompt = Extract<Prompt, { kind: 'approve-open' }>;

function ConfirmPayment({ prompt, onAnswer }: { prompt: PaymentPrompt; onAnswer: (answer: boolean) => void }) {
  const { occulta } = useApp();
  const peerId = occulta.channels.get(prompt.channelId).peer.peerId;
  return (
    <Modal title="Confirm payment">
      <p>
        Pay <strong>{formatAmount(tokenName(prompt.token), prompt.amount)}</strong> to {peerName(peerId, nicknames(occulta))} in your channel?
      </p>
      <div className="stack">
        <Button className="primary wide" onClick={() => onAnswer(true)}>
          Confirm payment
        </Button>
        <Button className="ghost wide" onClick={() => onAnswer(false)}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

/** BRD 2.2.7: a channel that asks for the user's money needs approval; the user can name the peer then. */
function ApproveOpen({ prompt, onAnswer }: { prompt: OpenPrompt; onAnswer: (answer: boolean) => void }) {
  const { occulta } = useApp();
  const { request } = prompt;
  const token = tokenName(request.token);
  const [nickname, setNicknameText] = useState('');
  const accept = useAction(async () => {
    if (nickname.trim()) await setNickname(occulta, request.peerId, nickname);
    onAnswer(true);
  });
  return (
    <Modal title="Channel request">
      <p>
        Someone with your invite wants to open a channel. They fund <strong>{formatAmount(token, request.amount)}</strong> and ask you to fund{' '}
        <strong>{formatAmount(token, request.peerAmount)}</strong>.
      </p>
      <p>
        Dispute window: {Number(request.window) / 86_400} days · closing fee {formatAmount(token, request.closingFee)} (paid by them)
      </p>
      <Field label="Nickname for them (optional)" hint="Only you see it. You can change it later.">
        <input value={nickname} maxLength={MAX_NICKNAME} placeholder="e.g. Bob" onChange={(e) => setNicknameText(e.target.value)} />
      </Field>
      <ErrorNote error={accept.error} />
      <div className="stack">
        <Button className="primary wide" busy={accept.busy} onClick={() => void accept.perform()}>
          Accept and fund
        </Button>
        <Button className="ghost wide" onClick={() => onAnswer(false)}>
          Decline
        </Button>
      </div>
    </Modal>
  );
}

/** The wallet's own dialog for questions the framework asks (BRD 2.2.7, 2.2.8). */
export function PromptDialog({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (answer: boolean) => void }) {
  return prompt.kind === 'confirm-payment' ? <ConfirmPayment prompt={prompt} onAnswer={onAnswer} /> : <ApproveOpen key={prompt.request.channelId} prompt={prompt} onAnswer={onAnswer} />;
}
