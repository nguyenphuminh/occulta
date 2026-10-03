import { useApp } from '../../app/context.ts';
import { PUBLIC_ADDRESS_TEXT } from '../../shared/addresses.ts';
import { formatAmount, tokenId } from '../../shared/amounts.ts';
import { EyeIcon } from '../../shared/icons.tsx';
import { Card, Copy, ErrorNote, useLoad } from '../../shared/ui.tsx';

/** The active account's public ETH and USDG on the selected network (BRD 2.2.14.4). */
function usePublicBalances() {
  const { occulta, version } = useApp();
  const account = occulta.wallet.activeAccount();
  const network = occulta.network();
  return useLoad(
    async () => ({
      eth: await occulta.chain.publicBalance(account.address, 0n),
      usdg: await occulta.chain.publicBalance(account.address, tokenId('usdg', network)),
    }),
    `${version}/${account.id}/${network.id}`,
  );
}

export function PublicCard() {
  const { occulta } = useApp();
  const { address } = occulta.wallet.activeAccount();
  const balances = usePublicBalances();
  return (
    <Card
      title="Public balance"
      className="public-card"
      actions={
        <span className="pill public-tag">
          <EyeIcon /> Visible on-chain
        </span>
      }
    >
      <dl className="amounts">
        <div>
          <dt>ETH</dt>
          <dd data-testid="public-eth">{balances.data ? formatAmount('eth', balances.data.eth) : '…'}</dd>
        </div>
        <div>
          <dt>USDG</dt>
          <dd data-testid="public-usdg">{balances.data ? formatAmount('usdg', balances.data.usdg) : '…'}</dd>
        </div>
      </dl>
      <div className="address-row">
        <span className="mono" data-testid="public-address">
          {address}
        </span>
        <Copy text={address} label="Copy address" />
      </div>
      <p className="muted small">{PUBLIC_ADDRESS_TEXT}</p>
      <ErrorNote error={balances.error} />
    </Card>
  );
}
