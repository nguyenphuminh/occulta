import { useState } from 'react';
import { useApp } from '../../app/context.ts';
import { readSettings, startNode, writeSettings, type WebSettings } from '../../app/settings.ts';
import { Button, Card, ErrorNote, Field, Notice, useAction } from '../../shared/ui.tsx';
import { RestoreWallet } from '../onboarding/index.ts';

function EditableList({ title, fixed, own, placeholder, onChange }: { title: string; fixed: string[]; own: string[]; placeholder: string; onChange: (next: string[]) => Promise<void> }) {
  const [entry, setEntry] = useState('');
  const save = useAction(onChange);
  return (
    <Card title={title}>
      <ul className="list">
        {fixed.map((item) => (
          <li key={`fixed-${item}`}>
            <code>{item}</code> <span className="muted">(network default)</span>
          </li>
        ))}
        {own.map((item) => (
          <li key={item}>
            <code>{item}</code>{' '}
            <Button className="link" onClick={() => void save.perform(own.filter((o) => o !== item))}>
              Remove
            </Button>
          </li>
        ))}
        {fixed.length + own.length === 0 ? <li className="muted">None yet.</li> : null}
      </ul>
      <Field label="Add">
        <input value={entry} placeholder={placeholder} spellCheck={false} onChange={(e) => setEntry(e.target.value.trim())} />
      </Field>
      <Button
        busy={save.busy}
        disabled={!entry || own.includes(entry)}
        onClick={() =>
          void save.perform([entry, ...own]).then(() => {
            setEntry('');
          })
        }
      >
        Add
      </Button>
      <ErrorNote error={save.error} />
    </Card>
  );
}

/** Relays and relayers of the network (BRD 2.2.11, 2.2.13) and export/import (BRD 2.2.14.6). */
export function Settings() {
  const { occulta, refresh, version } = useApp();
  const network = occulta.network();
  const settings = readSettings(occulta);
  const update = async (next: WebSettings) => {
    await writeSettings(occulta, next);
    refresh();
  };
  const lastExport = occulta.wallet.lastExportAt();
  const exportFile = useAction(async () => {
    const content = await occulta.wallet.exportFile();
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `occulta-wallet-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    refresh();
  });
  return (
    <div className="grid" data-version={version}>
      <EditableList
        title={`Transaction relayers on ${network.name}`}
        fixed={network.relayers}
        own={settings.relayers}
        placeholder="https://relayer.example"
        onChange={(relayers) => update({ ...settings, relayers })}
      />
      <EditableList
        title={`libp2p relays on ${network.name}`}
        fixed={network.libp2pRelays}
        own={settings.libp2pRelays}
        placeholder="/dns4/relay.example/tcp/443/wss/p2p/12D3…"
        onChange={(libp2pRelays) => update({ ...settings, libp2pRelays })}
      />
      <Card title="Export">
        <p data-testid="last-export">Last export: {lastExport === null ? 'never' : new Date(lastExport).toLocaleString()}</p>
        <Notice tone="warn">The file holds everything, encrypted with your wallet password. Channel payments made after the export are not in it; restoring an old file means acting on an old channel state.</Notice>
        <Button busy={exportFile.busy} onClick={() => void exportFile.perform()}>
          Download export file
        </Button>
        <ErrorNote error={exportFile.error} />
      </Card>
      <RestoreWallet
        occulta={occulta}
        onReady={async () => {
          await startNode(occulta);
          refresh();
        }}
      />
    </div>
  );
}
