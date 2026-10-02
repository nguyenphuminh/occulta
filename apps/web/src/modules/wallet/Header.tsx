import { useState } from 'react';
import { useApp } from '../../app/context.ts';
import { startNode } from '../../app/settings.ts';
import { Button, ErrorNote, Field, Modal, useAction } from '../../shared/ui.tsx';

/** Accounts (BRD 2.2.14.2), networks (2.2.14.5) and the Lock button (2.2.14.3). */
export function Header() {
  const { occulta, refresh, lock } = useApp();
  const { wallet } = occulta;
  const active = wallet.activeAccount();
  const [importing, setImporting] = useState(false);
  const [key, setKey] = useState('');
  const change = useAction(async (apply: () => Promise<unknown>) => {
    await apply();
    await startNode(occulta);
    refresh();
  });
  const add = useAction(async () => {
    await wallet.addAccount();
    refresh();
  });
  const importKey = useAction(async () => {
    await wallet.importAccount(key);
    setKey('');
    setImporting(false);
    refresh();
  });

  return (
    <header className="header">
      <strong className="brand">Occulta</strong>
      <Field label="Account">
        <select value={active.id} disabled={change.busy} onChange={(e) => void change.perform(() => wallet.setActiveAccount(e.target.value))}>
          {wallet.accounts().map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} · {a.address.slice(0, 6)}…{a.address.slice(-4)}
            </option>
          ))}
        </select>
      </Field>
      {wallet.hasRecoveryPhrase() ? (
        <Button className="secondary" busy={add.busy} onClick={() => void add.perform()}>
          Add account
        </Button>
      ) : null}
      <Button className="secondary" onClick={() => setImporting(true)}>
        Import key
      </Button>
      <Field label="Network">
        <select value={wallet.networkId()} disabled={change.busy} onChange={(e) => void change.perform(() => wallet.setNetwork(e.target.value))}>
          {occulta.networks().map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      </Field>
      <Button className="secondary" onClick={() => void lock()}>
        Lock
      </Button>
      <ErrorNote error={change.error ?? add.error} />
      {importing ? (
        <Modal title="Import an account from a private key">
          <Field label="Private key">
            <input value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <ErrorNote error={importKey.error} />
          <div className="row">
            <Button busy={importKey.busy} disabled={!key} onClick={() => void importKey.perform()}>
              Import
            </Button>
            <Button className="secondary" onClick={() => setImporting(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </header>
  );
}
