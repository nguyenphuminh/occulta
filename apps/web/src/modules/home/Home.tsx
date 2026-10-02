import { useApp } from '../../app/context.ts';
import { NotesCard, ShieldedAddressCard, ShieldedHero } from '../pool/index.ts';
import { PublicCard } from '../public/index.ts';

/** The overview: the shielded balance and its actions first, then public funds and the notes. */
export function Home() {
  const { occulta, version } = useApp();
  const account = occulta.wallet.activeAccount();
  return (
    <div className="page" data-version={version}>
      <header className="page-head">
        <div>
          <p className="muted small">{occulta.network().name}</p>
          <h1>{account.label}</h1>
        </div>
      </header>
      <ShieldedHero />
      <div className="grid two">
        <PublicCard />
        <ShieldedAddressCard />
        <NotesCard />
      </div>
    </div>
  );
}
