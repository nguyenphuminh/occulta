import { shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { Card, Copy, Notice, Page, Qr, useLoad } from '../../shared/ui.tsx';

/** Both ways to get paid: the shielded address for private payments, the public one for public sends. */
export function Receive() {
  const { occulta } = useApp();
  const account = occulta.wallet.activeAccount();
  const shielded = useLoad(async () => shieldedAddressOf(await occulta.keys.poolKeys()), account.id);
  return (
    <Page title="Receive" back="#/">
      <div className="grid two">
        <Card title="Private payments">
          <Notice>Share your shielded address privately. Payments to it cannot be seen on-chain.</Notice>
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
        <Card title="Public address">
          <Notice>Your public address, for public sends and for gas. Everything sent here is visible on-chain.</Notice>
          <Qr text={account.address} label="Address QR code" />
          <p className="mono break">{account.address}</p>
          <Copy text={account.address} label="Copy address" />
        </Card>
      </div>
    </Page>
  );
}
