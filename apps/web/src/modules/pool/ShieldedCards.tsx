import { shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, tokenName } from '../../shared/amounts.ts';
import { Card, Copy, useLoad } from '../../shared/ui.tsx';

/** The address others pay privately (BRD 2.2.0). */
export function ShieldedAddressCard() {
  const { occulta } = useApp();
  const account = occulta.wallet.activeAccount();
  const address = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  return (
    <Card title="Shielded address">
      <p className="mono break" data-testid="shielded-address">
        {address.data ?? '…'}
      </p>
      <div className="row">
        {address.data ? <Copy text={address.data} label="Copy shielded address" /> : null}
        <a className="pill-link" href="#/receive">
          Show QR code
        </a>
      </div>
      <p className="muted small">Share it privately to get paid inside the pool. Payments to it cannot be seen on-chain.</p>
    </Card>
  );
}

/** The account's unspent notes on this network. */
export function NotesCard() {
  const { occulta } = useApp();
  const notes = occulta.pool.notes().filter((n) => !n.spent);
  return (
    <Card title="Notes">
      <p className="muted">
        {notes.length} unspent {notes.length === 1 ? 'note' : 'notes'}
      </p>
      {notes.length > 0 ? (
        <ul className="rows">
          {notes.map((n) => (
            <li key={n.commitment.toString()} className="row-item">
              <div className="row-main">
                <strong>{formatAmount(tokenName(n.token), n.amount)}</strong>
                <span className="muted small">{n.secret === 'spending' ? `Note #${n.leafIndex}` : `Channel payout · note #${n.leafIndex}`}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
