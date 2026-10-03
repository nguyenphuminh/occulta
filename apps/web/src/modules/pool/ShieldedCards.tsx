import { shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { SHIELDED_ADDRESS_TEXT } from '../../shared/addresses.ts';
import { formatAmount, tokenName } from '../../shared/amounts.ts';
import { Copy, useLoad } from '../../shared/ui.tsx';

/** The address others pay privately (BRD 2.2.0) and the account's unspent notes, under the shielded balance. */
export function ShieldedDetails() {
  const { occulta } = useApp();
  const account = occulta.wallet.activeAccount();
  const address = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  const notes = occulta.pool.notes().filter((n) => !n.spent);
  return (
    <div className="shielded-details">
      <div className="detail-row">
        <div className="row-main">
          <span className="detail-label">Shielded address</span>
          <span className="mono truncate" data-testid="shielded-address">
            {address.data ?? '…'}
          </span>
        </div>
        {address.data ? <Copy text={address.data} label="Copy shielded address" /> : null}
      </div>
      <p className="muted small">{SHIELDED_ADDRESS_TEXT}</p>
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
                  <span className="muted small">{n.secret === 'spending' ? `Note #${n.leafIndex}` : `Channel payout · note #${n.leafIndex}`}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Deposits and payments you receive become notes.</p>
        )}
      </details>
    </div>
  );
}
