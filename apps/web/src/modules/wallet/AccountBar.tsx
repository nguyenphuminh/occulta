import { useApp } from '../../app/context.ts';
import { startNode } from '../../app/settings.ts';
import { LockIcon } from '../../shared/icons.tsx';
import { ErrorNote, Field, useAction } from '../../shared/ui.tsx';

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
        <select value={wallet.networkId()} disabled={change.busy} onChange={(e) => void change.perform(() => wallet.setNetwork(e.target.value))}>
          {occulta.networks().map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      </Field>
      <button type="button" className="ghost lock" onClick={() => void lock()}>
        <LockIcon />
        <span>Lock</span>
      </button>
      <ErrorNote error={change.error} />
    </div>
  );
}
