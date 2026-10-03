import { shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { SHIELDED_ADDRESS_TEXT, shortAddress } from '../../shared/addresses.ts';
import { formatAmount, tokenId, tokenName } from '../../shared/amounts.ts';
import { DepositIcon, ReceiveIcon, SendIcon, ShieldIcon, WithdrawIcon } from '../../shared/icons.tsx';
import { ActionLink, Button, Copy, ErrorNote, Notice, useAction, useLoad } from '../../shared/ui.tsx';

/** The shielded balance (BRD 2.2.1–2.2.5) with everything that belongs to it: its actions, the address others pay, the notes. */
export function ShieldedHero() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const account = occulta.wallet.activeAccount();
  const balances = occulta.pool.balances();
  const notes = occulta.pool.notes().filter((n) => !n.spent);
  const address = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  const sync = useAction(async () => {
    await occulta.pool.sync();
    refresh();
  });
  return (
    <section className="hero-card" aria-label="Shielded balance">
      <div className="hero-card-top">
        <span className="eyebrow">
          <ShieldIcon /> Shielded balance · private
        </span>
        <Button className="ghost small on-dark" busy={sync.busy} onClick={() => void sync.perform()}>
          Sync now
        </Button>
      </div>
      <div className="hero-address">
        <div className="detail-row">
          <div className="row-main">
            <span className="detail-label">Shielded address</span>
            <span className="address mono" data-testid="shielded-address" title={address.data ?? undefined}>
              {address.data ? shortAddress(address.data) : '…'}
            </span>
          </div>
          {address.data ? <Copy text={address.data} label="Copy shielded address" className="ghost small on-dark" /> : null}
        </div>
        <p className="hero-note">{SHIELDED_ADDRESS_TEXT}</p>
      </div>
      <div className="big-amounts">
        <span className="big" data-testid="shielded-eth">
          {formatAmount('eth', balances.get(0n) ?? 0n)}
        </span>
        <span className="medium" data-testid="shielded-usdg">
          {formatAmount('usdg', balances.get(tokenId('usdg', network)) ?? 0n)}
        </span>
      </div>
      {!network.contracts ? <Notice tone="warn">Occulta is not deployed on {network.name} yet.</Notice> : null}
      <ErrorNote error={sync.error} />
      <nav className="actions" aria-label="Shielded actions">
        <ActionLink href="#/deposit" icon={<DepositIcon />} label="Deposit" />
        <ActionLink href="#/withdraw" icon={<WithdrawIcon />} label="Withdraw" />
        <ActionLink href="#/receive" icon={<ReceiveIcon />} label="Receive" />
        <ActionLink href="#/send" icon={<SendIcon />} label="Send" />
      </nav>
      <div className="hero-details">
        <details className="notes">
          <summary>
            {notes.length} unspent {notes.length === 1 ? 'note' : 'notes'}
          </summary>
          {notes.length > 0 ? (
            <ul className="rows">
              {notes.map((n) => (
                <li key={n.commitment.toString()} className="row-item">
                  <div className="row-main">
                    <strong>{formatAmount(tokenName(n.token), n.amount)}</strong>
                    <span className="hero-note">{n.secret === 'spending' ? `Note #${n.leafIndex}` : `Channel payout · note #${n.leafIndex}`}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hero-note">Deposits and payments you receive become notes.</p>
          )}
        </details>
      </div>
    </section>
  );
}
