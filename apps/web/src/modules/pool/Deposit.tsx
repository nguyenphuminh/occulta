import { useState } from 'react';
import { ETH_PRESETS, USDG_PRESETS } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, Card, ErrorNote, Notice, Page, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

export const presetsOf = (token: TokenName) => (token === 'eth' ? ETH_PRESETS : USDG_PRESETS);

/** BRD 2.2.2: public funds of the account into the pool, with presets and the round-amount hint. */
export function Deposit() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  const deposit = useAction(async () => {
    await occulta.pool.deposit(tokenId(token, network), parseAmount(token, amount) as bigint);
    setAmount('');
    refresh();
    location.hash = '#/';
  });
  return (
    <Page title="Deposit" back="#/">
      <Card title="Deposit">
        <Notice>Moves public funds of this account into the pool. The account pays the gas; USDG is approved first.</Notice>
        <TokenSelect value={token} onChange={setToken} />
        <AmountField label="Amount" token={token} value={amount} onChange={setAmount} presets={presetsOf(token)} />
        <Button className="primary wide" busy={deposit.busy} disabled={parseAmount(token, amount) === null} onClick={() => void deposit.perform()}>
          Deposit
        </Button>
        <ErrorNote error={deposit.error} />
      </Card>
    </Page>
  );
}
