import { useState } from 'react';
import { isAddress } from 'viem';
import { useApp } from '../../app/context.ts';
import { parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Card, Field, Notice, Page, RelayedSubmit } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';
import { presetsOf } from './Deposit.tsx';

/** BRD 2.2.5 and 2.2.14.4: out of the pool, by default to a never-used account of this wallet. */
export function Withdraw() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'fresh' | 'address'>('fresh');
  const [address, setAddress] = useState('');
  const [done, setDone] = useState<string | null>(null);
  return (
    <Page title="Withdraw" back="#/">
      <Card title="Withdraw">
        <TokenSelect value={token} onChange={setToken} />
        <AmountField label="Amount" token={token} value={amount} onChange={setAmount} presets={presetsOf(token)} />
        <fieldset className="choice">
          <legend>Send to</legend>
          <label className={mode === 'fresh' ? 'option on' : 'option'}>
            <input type="radio" checked={mode === 'fresh'} onChange={() => setMode('fresh')} /> A new, never-used account of this wallet
          </label>
          <label className={mode === 'address' ? 'option on' : 'option'}>
            <input type="radio" checked={mode === 'address'} onChange={() => setMode('address')} /> Another address
          </label>
        </fieldset>
        {mode === 'address' ? (
          <Field label="Recipient address" hint="Use an address with no visible link to your other addresses.">
            <input value={address} spellCheck={false} placeholder="0x…" onChange={(e) => setAddress(e.target.value.trim())} />
          </Field>
        ) : null}
        <Notice>Tip: waiting longer between depositing and withdrawing makes the two harder to link.</Notice>
        <RelayedSubmit
          label="Withdraw"
          token={token}
          tokenId={tokenId(token, network)}
          disabled={parseAmount(token, amount) === null || (mode === 'address' && !isAddress(address))}
          relayer={() => occulta.relayer()}
          details={
            <p>
              Withdraw <strong>{amount} {token.toUpperCase()}</strong> to {mode === 'fresh' ? 'a new account of this wallet' : address}. The recipient needs no ETH: the relayer pays the gas.
            </p>
          }
          run={async (relayer) => {
            const to = mode === 'fresh' ? (await occulta.wallet.freshAccount()).address : (address as `0x${string}`);
            await occulta.pool.withdraw(tokenId(token, network), parseAmount(token, amount) as bigint, to, relayer);
            setDone(to);
          }}
          onDone={() => {
            setAmount('');
            refresh();
          }}
        />
        {done ? <Notice tone="ok">Withdrawn to {done}.</Notice> : null}
      </Card>
    </Page>
  );
}
