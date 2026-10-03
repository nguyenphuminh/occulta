import { useApp } from '../../app/context.ts';
import { PUBLIC_ADDRESS_TEXT } from '../../shared/addresses.ts';
import { formatAmount, tokenId } from '../../shared/amounts.ts';
import { EyeIcon } from '../../shared/icons.tsx';
import { Copy, ErrorNote, useLoad } from '../../shared/ui.tsx';

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

/** Laid out like the shielded balance, but quieter: it is only there to inform. */
export function PublicCard() {
  const { occulta } = useApp();
  const { address } = occulta.wallet.activeAccount();
  const balances = usePublicBalances();
  return (
    <section className="hero-card public" aria-label="Public balance">
      <div className="hero-card-top">
        <span className="eyebrow">
          <EyeIcon /> Public balance · visible on-chain
        </span>
      </div>
      <div className="big-amounts">
        <span className="big" data-testid="public-eth">
          {balances.data ? formatAmount('eth', balances.data.eth) : '…'}
        </span>
        <span className="medium" data-testid="public-usdg">
          {balances.data ? formatAmount('usdg', balances.data.usdg) : '…'}
        </span>
      </div>
      <ErrorNote error={balances.error} />
      <div className="hero-details">
        <div className="detail-row">
          <div className="row-main">
            <span className="detail-label">Public address</span>
            <span className="mono truncate" data-testid="public-address">
              {address}
            </span>
          </div>
          <Copy text={address} label="Copy address" />
        </div>
        <p className="hero-note">{PUBLIC_ADDRESS_TEXT}</p>
      </div>
    </section>
  );
}
