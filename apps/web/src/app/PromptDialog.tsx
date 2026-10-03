import { formatAmount, tokenName } from '../shared/amounts.ts';
import { Button, Modal } from '../shared/ui.tsx';
import { nicknames, peerName, RequestAnswer, requestTerms, useSecondsLeft, type ChannelRequest } from '../modules/channels/index.ts';
import { useApp } from './context.ts';
import type { Asked, Prompt } from './prompts.ts';

type PaymentPrompt = Extract<Prompt, { kind: 'confirm-payment' }>;

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

/**
 * BRD 2.2.7: a channel that asks for the user's money needs approval. The user can close the dialog
 * and answer from the channel list instead, within the time left (BRD 2.2.14.9).
 */
function ApproveOpen({ asked }: { asked: ChannelRequest }) {
  const { prompts } = useApp();
  const { request } = asked.prompt;
  const token = tokenName(request.token);
  const secondsLeft = useSecondsLeft(asked.deadline);
  return (
    <Modal title="Channel request" onClose={() => prompts.hide(asked.id)}>
      <p>Someone with your invite wants to open a channel. {requestTerms(request)}.</p>
      <p>
        Dispute window: {Number(request.window) / 86_400} days · closing fee {formatAmount(token, request.closingFee)} (paid by them)
      </p>
      <p className="muted small">{secondsLeft} s left to answer. You can close this and answer from Channels.</p>
      <RequestAnswer asked={asked} />
    </Modal>
  );
}

/** The wallet's own dialog for questions the framework asks (BRD 2.2.7, 2.2.8). */
export function PromptDialog({ asked }: { asked: Asked }) {
  const { prompts } = useApp();
  const { prompt } = asked;
  return prompt.kind === 'confirm-payment' ? (
    <ConfirmPayment prompt={prompt} onAnswer={(answer) => prompts.answer(asked.id, answer)} />
  ) : (
    <ApproveOpen key={asked.id} asked={{ ...asked, prompt }} />
  );
}
