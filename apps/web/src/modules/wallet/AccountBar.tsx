import type { SelectHTMLAttributes } from 'react';
import { useApp } from '../../app/context.ts';
import { startNode } from '../../app/settings.ts';
import { LockIcon } from '../../shared/icons.tsx';
import { networkLogo } from '../../shared/networks.ts';
import { ErrorNote, Field, useAction } from '../../shared/ui.tsx';

/** A select with a logo at its start; it takes the field's id, so the field's label still names it. */
function LogoSelect({ logo, ...select }: SelectHTMLAttributes<HTMLSelectElement> & { logo: string | null }) {
  return (
    <span className="logo-select">
      {logo ? <img className="logo-select-logo" src={logo} alt="" data-testid="network-logo" /> : null}
      <select {...select} className={logo ? 'has-logo' : undefined} />
    </span>
  );
}

/** The active account and network (BRD 2.2.14.2, 2.2.14.5) and the Lock button (2.2.14.3). */
export function AccountBar() {
  const { occulta, refresh, lock } = useApp();
  const { wallet } = occulta;
  const active = wallet.activeAccount();
  const change = useAction(async (apply: () => Promise<unknown>) => {
    await apply();
    await startNode(occulta);
    refresh();
  });
  return (
    <div className="account-bar">
      <Field label="Account">
        <select value={active.id} disabled={change.busy} onChange={(e) => void change.perform(() => wallet.setActiveAccount(e.target.value))}>
          {wallet.accounts().map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} · {a.address.slice(0, 6)}…{a.address.slice(-4)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Network">
        <LogoSelect logo={networkLogo(occulta.network())} value={wallet.networkId()} disabled={change.busy} onChange={(e) => void change.perform(() => wallet.setNetwork(e.target.value))}>
          {occulta.networks().map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </LogoSelect>
      </Field>
      <button type="button" className="ghost lock" aria-label="Lock" onClick={() => void lock()}>
        <LockIcon />
        <span>Lock</span>
      </button>
      <ErrorNote error={change.error} />
    </div>
  );
}
