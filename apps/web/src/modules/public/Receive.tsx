import { shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { PUBLIC_ADDRESS_TEXT, SHIELDED_ADDRESS_TEXT } from '../../shared/addresses.ts';
import { Copy, Modal, Notice, Qr, closeTo, useLoad } from '../../shared/ui.tsx';

/** Both ways to get paid: the shielded address for private payments, the public one for funds from other wallets. */
export function Receive() {
  const { occulta } = useApp();
  const account = occulta.wallet.activeAccount();
  const shielded = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  return (
    <Modal title="Receive" wide onClose={closeTo('#/wallet')}>
      <div className="receive">
        <section className="receive-part" aria-label="Private payments">
          <h3>Private payments</h3>
          <Notice>{SHIELDED_ADDRESS_TEXT}</Notice>
          {shielded.data ? (
            <>
              <Qr text={shielded.data} label="Shielded address QR code" />
              <p className="mono break">{shielded.data}</p>
              <Copy text={shielded.data} label="Copy shielded address" />
            </>
          ) : (
            <p className="muted">…</p>
          )}
        </section>
        <section className="receive-part public" aria-label="Public address">
          <h3>Public address</h3>
          <Notice>{PUBLIC_ADDRESS_TEXT}</Notice>
          <Qr text={account.address} label="Address QR code" />
          <p className="mono break">{account.address}</p>
          <Copy text={account.address} label="Copy address" />
        </section>
      </div>
    </Modal>
  );
}
