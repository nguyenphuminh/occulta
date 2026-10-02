import { useApp } from '../../app/context.ts';
import { formatAmount, tokenId } from '../../shared/amounts.ts';
import { DepositIcon, ReceiveIcon, SendIcon, ShieldIcon, WithdrawIcon } from '../../shared/icons.tsx';
import { ActionLink, Button, ErrorNote, Notice, useAction } from '../../shared/ui.tsx';

/** The shielded balance (BRD 2.2.1–2.2.5) and the actions that move it. */
export function ShieldedHero() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const balances = occulta.pool.balances();
  const sync = useAction(async () => {
    await occulta.pool.sync();
    refresh();
  });
  return (
    <section className="hero-card" aria-label="Shielded balance">
      <div className="hero-card-top">
        <span className="eyebrow">
          <ShieldIcon /> Shielded balance
        </span>
        <Button className="ghost small on-dark" busy={sync.busy} onClick={() => void sync.perform()}>
          Sync now
        </Button>
      </div>
      <div className="big-amounts">
        <span className="big" data-testid="shielded-eth">
          {formatAmount('eth', balances.get(0n) ?? 0n)}
        </span>
        <span className="medium" data-testid="shielded-usdg">
          {formatAmount('usdg', balances.get(tokenId('usdg', network)) ?? 0n)}
        </span>
      </div>
      {!network.contracts ? <Notice tone="warn">Occulta is not deployed on {network.name} yet.</Notice> : null}
      <ErrorNote error={sync.error} />
      <nav className="actions" aria-label="Shielded actions">
        <ActionLink href="#/deposit" icon={<DepositIcon />} label="Deposit" />
        <ActionLink href="#/send" icon={<SendIcon />} label="Send" />
        <ActionLink href="#/withdraw" icon={<WithdrawIcon />} label="Withdraw" />
        <ActionLink href="#/receive" icon={<ReceiveIcon />} label="Receive" />
      </nav>
    </section>
  );
}
