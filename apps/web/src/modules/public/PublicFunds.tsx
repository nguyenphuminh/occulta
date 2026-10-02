import { useState } from 'react';
import { isAddress } from 'viem';
import { useApp } from '../../app/context.ts';
import { formatAmount, parseAmount, TOKENS, SYMBOL, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, Card, Copy, ErrorNote, Field, Notice, Qr, useAction, useLoad } from '../../shared/ui.tsx';

export function TokenSelect({ value, onChange }: { value: TokenName; onChange: (t: TokenName) => void }) {
  return (
    <Field label="Token">
      <select value={value} onChange={(e) => onChange(e.target.value as TokenName)}>
        {TOKENS.map((t) => (
          <option key={t} value={t}>
            {SYMBOL[t]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** BRD 2.2.14.4: the account's public balances, a receive screen with a QR code, and public sends. */
export function PublicFunds() {
  const { occulta, version, refresh } = useApp();
  const { wallet, chain } = occulta;
  const account = wallet.activeAccount();
  const network = occulta.network();
  const balances = useLoad(
    async () => ({ eth: await chain.publicBalance(account.address, 0n), usdg: await chain.publicBalance(account.address, tokenId('usdg', network)) }),
    `${version}/${account.id}/${network.id}`,
  );
  const [token, setToken] = useState<TokenName>('eth');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const send = useAction(async () => {
    await chain.sendPublic(wallet.signer(), tokenId(token, network), to as `0x${string}`, parseAmount(token, amount) as bigint);
    await wallet.markUsed(account.id);
    setAmount('');
    refresh();
  });

  return (
    <div className="grid">
      <Card title="Public balance">
        <p className="address" data-testid="public-address">
          {account.address}
        </p>
        <ErrorNote error={balances.error} />
        <dl className="balances">
          <dt>ETH</dt>
          <dd data-testid="public-eth">{balances.data ? formatAmount('eth', balances.data.eth) : '…'}</dd>
          <dt>USDG</dt>
          <dd data-testid="public-usdg">{balances.data ? formatAmount('usdg', balances.data.usdg) : '…'}</dd>
        </dl>
      </Card>
      <Card title="Receive">
        <Qr text={account.address} label="Address QR code" />
        <Copy text={account.address} label="Copy address" />
      </Card>
      <Card title="Send publicly">
        <Notice>Public sends are visible on-chain and paid with this account&apos;s ETH.</Notice>
        <TokenSelect value={token} onChange={setToken} />
        <Field label="To address">
          <input value={to} spellCheck={false} onChange={(e) => setTo(e.target.value.trim())} />
        </Field>
        <AmountField label="Amount" token={token} value={amount} onChange={setAmount} />
        <Button busy={send.busy} disabled={!isAddress(to) || parseAmount(token, amount) === null} onClick={() => void send.perform()}>
          Send
        </Button>
        <ErrorNote error={send.error} />
      </Card>
    </div>
  );
}
