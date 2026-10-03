import { useState } from 'react';
import { isAddress } from 'viem';
import { useApp } from '../../app/context.ts';
import { parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Card, Field, Notice, Page, RelayedSubmit } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';
import { presetsOf } from './Deposit.tsx';

/** BRD 2.2.5: out of the pool to the address the money should reach, ideally one with no history linking it to the user. */
export function Withdraw() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [done, setDone] = useState<string | null>(null);
  return (
    <Page title="Withdraw" back="#/wallet">
      <Card title="Withdraw">
        <TokenSelect value={token} onChange={setToken} />
        <AmountField label="Amount" token={token} value={amount} onChange={setAmount} presets={presetsOf(token)} />
        <Field label="Recipient address" hint="Use an address with no history linking it to you, for example a new account in MetaMask.">
          <input value={address} spellCheck={false} placeholder="0x…" onChange={(e) => setAddress(e.target.value.trim())} />
        </Field>
        <Notice>Tip: waiting longer between depositing and withdrawing makes the two harder to link.</Notice>
        <RelayedSubmit
          label="Withdraw"
          token={token}
          tokenId={tokenId(token, network)}
          disabled={parseAmount(token, amount) === null || !isAddress(address)}
          relayer={() => occulta.relayer()}
          details={
            <p>
              Withdraw <strong>{amount} {token.toUpperCase()}</strong> to {address}. The recipient needs no ETH: the relayer pays the gas.
            </p>
          }
          run={async (relayer) => {
            await occulta.pool.withdraw(tokenId(token, network), parseAmount(token, amount) as bigint, address as `0x${string}`, relayer);
            setDone(address);
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
