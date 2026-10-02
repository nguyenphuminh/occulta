import { useState } from 'react';
import { isAddress } from 'viem';
import { useApp } from '../../app/context.ts';
import { parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, Card, ErrorNote, Field, Notice, Page, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from './TokenSelect.tsx';

/** BRD 2.2.14.4: a public send of ETH or USDG from the active account. */
export function SendPublic() {
  const { occulta, refresh } = useApp();
  const { wallet, chain } = occulta;
  const network = occulta.network();
  const [token, setToken] = useState<TokenName>('eth');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const send = useAction(async () => {
    await chain.sendPublic(wallet.signer(), tokenId(token, network), to as `0x${string}`, parseAmount(token, amount) as bigint);
    await wallet.markUsed(wallet.activeAccount().id);
    setAmount('');
    refresh();
    location.hash = '#/';
  });
  return (
    <Page title="Send publicly" back="#/">
      <Card title="Send publicly">
        <Notice tone="warn">Public sends are visible on-chain and paid with this account&apos;s ETH. To pay privately, use Send from the shielded balance.</Notice>
        <TokenSelect value={token} onChange={setToken} />
        <Field label="To address">
          <input value={to} spellCheck={false} placeholder="0x…" onChange={(e) => setTo(e.target.value.trim())} />
        </Field>
        <AmountField label="Amount" token={token} value={amount} onChange={setAmount} />
        <Button className="primary wide" busy={send.busy} disabled={!isAddress(to) || parseAmount(token, amount) === null} onClick={() => void send.perform()}>
          Send
        </Button>
        <ErrorNote error={send.error} />
      </Card>
    </Page>
  );
}
