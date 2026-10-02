import { useState } from 'react';
import { isAddress } from 'viem';
import { ETH_PRESETS, USDG_PRESETS, decodeShieldedAddress, shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, parseAmount, tokenId, tokenName, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, Card, Copy, ErrorNote, Field, Notice, Qr, RelayedSubmit, useAction, useLoad } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

const presetsOf = (token: TokenName) => (token === 'eth' ? ETH_PRESETS : USDG_PRESETS);

function isShieldedAddress(text: string): boolean {
  try {
    decodeShieldedAddress(text);
    return true;
  } catch {
    return false;
  }
}

/** BRD 2.2.0–2.2.5: shielded address, balance and notes; deposit, private transfer and withdraw. */
export function Shielded() {
  const { occulta, version, refresh } = useApp();
  const { wallet, pool } = occulta;
  const network = occulta.network();
  const account = wallet.activeAccount();
  const address = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  const balances = pool.balances();
  const notes = pool.notes().filter((n) => !n.spent);
  const sync = useAction(async () => {
    await pool.sync();
    refresh();
  });

  const [depositToken, setDepositToken] = useState<TokenName>('eth');
  const [depositAmount, setDepositAmount] = useState('');
  const deposit = useAction(async () => {
    await pool.deposit(tokenId(depositToken, network), parseAmount(depositToken, depositAmount) as bigint);
    setDepositAmount('');
    refresh();
  });

  const [payTo, setPayTo] = useState('');
  const [payToken, setPayToken] = useState<TokenName>('eth');
  const [payAmount, setPayAmount] = useState('');

  const [exitToken, setExitToken] = useState<TokenName>('eth');
  const [exitAmount, setExitAmount] = useState('');
  const [exitMode, setExitMode] = useState<'fresh' | 'address'>('fresh');
  const [exitAddress, setExitAddress] = useState('');
  const [lastExit, setLastExit] = useState<string | null>(null);

  return (
    <div className="grid" data-version={version}>
      {!network.contracts ? <Notice tone="warn">Occulta is not deployed on {network.name} yet.</Notice> : null}
      <Card title="Shielded address">
        <p className="address" data-testid="shielded-address">
          {address.data ?? '…'}
        </p>
        {address.data ? (
          <div className="row">
            <Copy text={address.data} label="Copy shielded address" />
          </div>
        ) : null}
        {address.data ? <Qr text={address.data} label="Shielded address QR code" /> : null}
        <Notice>Share it privately to get paid inside the pool. Payments to it cannot be seen on-chain.</Notice>
      </Card>

      <Card title="Shielded balance">
        <dl className="balances">
          <dt>ETH</dt>
          <dd data-testid="shielded-eth">{formatAmount('eth', balances.get(0n) ?? 0n)}</dd>
          <dt>USDG</dt>
          <dd data-testid="shielded-usdg">{formatAmount('usdg', balances.get(tokenId('usdg', network)) ?? 0n)}</dd>
        </dl>
        <Button className="secondary" busy={sync.busy} onClick={() => void sync.perform()}>
          Sync now
        </Button>
        <ErrorNote error={sync.error} />
        <details>
          <summary>{notes.length} unspent notes</summary>
          <ul className="notes">
            {notes.map((n) => (
              <li key={n.commitment.toString()}>
                {formatAmount(tokenName(n.token), n.amount)} {n.secret === 'spending' ? '' : '(channel payout)'}
              </li>
            ))}
          </ul>
        </details>
      </Card>

      <Card title="Deposit">
        <Notice>Moves public funds of this account into the pool. The account pays the gas.</Notice>
        <TokenSelect value={depositToken} onChange={setDepositToken} />
        <AmountField label="Amount" token={depositToken} value={depositAmount} onChange={setDepositAmount} presets={presetsOf(depositToken)} />
        <Button busy={deposit.busy} disabled={parseAmount(depositToken, depositAmount) === null} onClick={() => void deposit.perform()}>
          Deposit
        </Button>
        <ErrorNote error={deposit.error} />
      </Card>

      <Card title="Private transfer">
        <Field label="To shielded address">
          <input value={payTo} spellCheck={false} onChange={(e) => setPayTo(e.target.value.trim())} />
        </Field>
        <TokenSelect value={payToken} onChange={setPayToken} />
        <AmountField label="Amount" token={payToken} value={payAmount} onChange={setPayAmount} />
        <RelayedSubmit
          label="Send privately"
          token={payToken}
          tokenId={tokenId(payToken, network)}
          disabled={!isShieldedAddress(payTo) || parseAmount(payToken, payAmount) === null}
          relayer={() => occulta.relayer()}
          details={<p>Send {payAmount} {payToken.toUpperCase()} to the shielded address.</p>}
          run={(relayer) => pool.transfer(payTo, tokenId(payToken, network), parseAmount(payToken, payAmount) as bigint, relayer)}
          onDone={() => {
            setPayAmount('');
            refresh();
          }}
        />
      </Card>

      <Card title="Withdraw">
        <TokenSelect value={exitToken} onChange={setExitToken} />
        <AmountField label="Amount" token={exitToken} value={exitAmount} onChange={setExitAmount} presets={presetsOf(exitToken)} />
        <fieldset className="choice">
          <legend>Send to</legend>
          <label>
            <input type="radio" checked={exitMode === 'fresh'} onChange={() => setExitMode('fresh')} /> A new, never-used account of this wallet
          </label>
          <label>
            <input type="radio" checked={exitMode === 'address'} onChange={() => setExitMode('address')} /> Another address
          </label>
        </fieldset>
        {exitMode === 'address' ? (
          <Field label="Recipient address" hint="Use an address with no visible link to your other addresses.">
            <input value={exitAddress} spellCheck={false} onChange={(e) => setExitAddress(e.target.value.trim())} />
          </Field>
        ) : null}
        <Notice>Tip: waiting longer between depositing and withdrawing makes the two harder to link.</Notice>
        <RelayedSubmit
          label="Withdraw"
          token={exitToken}
          tokenId={tokenId(exitToken, network)}
          disabled={parseAmount(exitToken, exitAmount) === null || (exitMode === 'address' && !isAddress(exitAddress))}
          relayer={() => occulta.relayer()}
          details={
            <p>
              Withdraw {exitAmount} {exitToken.toUpperCase()} to {exitMode === 'fresh' ? 'a new account of this wallet' : exitAddress}.
            </p>
          }
          run={async (relayer) => {
            const to = exitMode === 'fresh' ? (await wallet.freshAccount()).address : (exitAddress as `0x${string}`);
            await pool.withdraw(tokenId(exitToken, network), parseAmount(exitToken, exitAmount) as bigint, to, relayer);
            setLastExit(to);
          }}
          onDone={() => {
            setExitAmount('');
            refresh();
          }}
        />
        {lastExit ? <Notice tone="ok">Withdrawn to {lastExit}.</Notice> : null}
      </Card>
    </div>
  );
}
