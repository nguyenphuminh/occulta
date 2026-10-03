import { shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { PUBLIC_ADDRESS_TEXT, SHIELDED_ADDRESS_TEXT } from '../../shared/addresses.ts';
import { Card, Copy, Notice, Page, Qr, useLoad } from '../../shared/ui.tsx';

/** Both ways to get paid: the shielded address for private payments, the public one for funds from other wallets. */
export function Receive() {
  const { occulta } = useApp();
  const account = occulta.wallet.activeAccount();
  const shielded = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  return (
    <Page title="Receive" back="#/wallet">
      <div className="grid two">
        <Card title="Private payments">
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
        </Card>
        <Card title="Public address" className="public-card">
          <Notice>{PUBLIC_ADDRESS_TEXT}</Notice>
          <Qr text={account.address} label="Address QR code" />
          <p className="mono break">{account.address}</p>
          <Copy text={account.address} label="Copy address" />
        </Card>
      </div>
    </Page>
  );
}
