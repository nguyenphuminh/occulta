import { useState } from 'react';
import { decodeShieldedAddress } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Card, Field, Page, RelayedSubmit } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

function isShieldedAddress(text: string): boolean {
  try {
    decodeShieldedAddress(text);
    return true;
  } catch {
    return false;
  }
}

/** BRD 2.2.3: a private payment to a shielded address, through a relayer. */
export function SendPrivately() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const [to, setTo] = useState('');
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  return (
    <Page title="Private transfer">
      <Card title="Send to a shielded address">
        <p className="muted small">Pays someone inside the pool from your shielded balance. Nobody else can see the amount or who paid whom. For repeated payments to the same person, a channel is faster and cheaper.</p>
        <Field label="To shielded address">
          <input value={to} spellCheck={false} placeholder="occ…" onChange={(e) => setTo(e.target.value.trim())} />
        </Field>
        <TokenSelect value={token} onChange={setToken} />
        <AmountField label="Amount" token={token} value={amount} onChange={setAmount} />
        <RelayedSubmit
          label="Send privately"
          token={token}
          tokenId={tokenId(token, network)}
          disabled={!isShieldedAddress(to) || parseAmount(token, amount) === null}
          relayer={() => occulta.relayer()}
          details={
            <p>
              Send <strong>{amount} {token.toUpperCase()}</strong> to the shielded address. Nobody else can see the amount or the recipient.
            </p>
          }
          run={(relayer) => occulta.pool.transfer(to, tokenId(token, network), parseAmount(token, amount) as bigint, relayer)}
          onDone={() => {
            setAmount('');
            refresh();
            location.hash = '#/wallet';
          }}
        />
      </Card>
    </Page>
  );
}
