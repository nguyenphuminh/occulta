import { formatAmount, tokenName } from '../shared/amounts.ts';
import { Button, Modal } from '../shared/ui.tsx';
import type { Prompt } from './prompts.ts';

/** The wallet's own dialog for questions the framework asks (BRD 2.2.7, 2.2.8). */
export function PromptDialog({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (answer: boolean) => void }) {
  if (prompt.kind === 'confirm-payment') {
    return (
      <Modal title="Confirm payment">
        <p>
          Pay <strong>{formatAmount(tokenName(prompt.token), prompt.amount)}</strong> in channel {prompt.channelId.slice(0, 8)}?
        </p>
        <div className="stack">
          <Button className="primary wide" onClick={() => onAnswer(true)}>Confirm payment</Button>
          <Button className="ghost wide" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
    );
  }
  const { request } = prompt;
  const token = tokenName(request.token);
  return (
    <Modal title="Channel request">
      <p>
        Someone with your invite wants to open a channel. They fund <strong>{formatAmount(token, request.amount)}</strong> and ask you to fund{' '}
        <strong>{formatAmount(token, request.peerAmount)}</strong>.
      </p>
      <p>
        Dispute window: {Number(request.window) / 86_400} days · closing fee {formatAmount(token, request.closingFee)} (paid by them)
      </p>
      <div className="stack">
        <Button className="primary wide" onClick={() => onAnswer(true)}>Accept and fund</Button>
        <Button className="ghost wide" onClick={() => onAnswer(false)}>
          Decline
        </Button>
      </div>
    </Modal>
  );
}
