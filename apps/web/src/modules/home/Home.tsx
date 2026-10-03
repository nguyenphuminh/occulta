import { useApp } from '../../app/context.ts';
import { ShieldedDetails, ShieldedHero } from '../pool/index.ts';
import { PublicCard } from '../public/index.ts';

/** My wallet: the shielded balance with everything that belongs to it first, the public balance after. */
export function MyWallet() {
  const { occulta, version } = useApp();
  const account = occulta.wallet.activeAccount();
  return (
    <div className="page" data-version={version}>
      <header className="page-head">
        <div>
          <p className="muted small">
            {account.label} · {occulta.network().name}
          </p>
          <h1>My wallet</h1>
        </div>
      </header>
      <div className="shielded-group">
        <ShieldedHero />
        <ShieldedDetails />
      </div>
      <PublicCard />
    </div>
  );
}
