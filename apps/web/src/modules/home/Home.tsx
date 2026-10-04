import { useApp } from '../../app/context.ts';
import { Deposit, SendPrivately, ShieldedHero, Withdraw } from '../pool/index.ts';
import { PublicCard, Receive } from '../public/index.ts';

/** The shielded balance's actions, each a dialog over My wallet with its own address. */
export type WalletDialog = 'deposit' | 'withdraw' | 'receive' | 'send';

/** My wallet: the shielded balance with everything that belongs to it first, the public balance after. */
export function MyWallet({ dialog }: { dialog: WalletDialog | null }) {
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
      <ShieldedHero />
      <PublicCard />
      {dialog === 'deposit' ? <Deposit /> : null}
      {dialog === 'withdraw' ? <Withdraw /> : null}
      {dialog === 'receive' ? <Receive /> : null}
      {dialog === 'send' ? <SendPrivately /> : null}
    </div>
  );
}
