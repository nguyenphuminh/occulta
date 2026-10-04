import { useState, type ReactNode } from 'react';
import { chainIdAt, defaultRpcUrls } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { readSettings, startNode, writeSettings, type WebSettings } from '../../app/settings.ts';
import { chooseTheme, themeChoice, type ThemeChoice } from '../../app/theme.ts';
import { BackIcon, ChannelsIcon, KeyIcon, ShieldIcon, ThemeIcon } from '../../shared/icons.tsx';
import { Button, Card, ErrorNote, Field, Notice, useAction } from '../../shared/ui.tsx';
import { RestoreWallet } from '../onboarding/index.ts';
import { Accounts } from '../wallet/index.ts';

export type SettingsCategory = 'accounts' | 'backup' | 'network' | 'appearance';

function EditableList({ title, fixed, own, placeholder, onChange }: { title: string; fixed: string[]; own: string[]; placeholder: string; onChange: (next: string[]) => Promise<void> }) {
  const [entry, setEntry] = useState('');
  const save = useAction(onChange);
  return (
    <Card title={title}>
      <ul className="rows">
        {fixed.map((item) => (
          <li key={`fixed-${item}`} className="row-item">
            <code className="mono break">{item}</code>
            <span className="pill">Network default</span>
          </li>
        ))}
        {own.map((item) => (
          <li key={item} className="row-item">
            <code className="mono break">{item}</code>
            <Button className="ghost small" onClick={() => void save.perform(own.filter((o) => o !== item))}>
              Remove
            </Button>
          </li>
        ))}
        {fixed.length + own.length === 0 ? <li className="muted">None yet.</li> : null}
      </ul>
      <div className="inline-form">
        <Field label="Add">
          <input value={entry} placeholder={placeholder} spellCheck={false} onChange={(e) => setEntry(e.target.value.trim())} />
        </Field>
        <Button
          className="secondary"
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
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}

/** BRD 2.2.14.6: the export file, and restoring one. */
function Backup() {
  const { occulta, refresh } = useApp();
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
    <>
      <Card title="Export">
        <p data-testid="last-export">Last export: {lastExport === null ? 'never' : new Date(lastExport).toLocaleString()}</p>
        <Notice tone="warn">The file holds everything, encrypted with your wallet password. Channel payments made after the export are not in it; restoring an old file means acting on an old channel state.</Notice>
        <Button className="primary wide" busy={exportFile.busy} onClick={() => void exportFile.perform()}>
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
    </>
  );
}

/**
 * BRD 2.2.14.5: the RPC endpoints the wallet reads the chain through, the user's own first, in the
 * order they were added. An endpoint is added only if it answers for this network.
 */
function RpcEndpoints({ settings, update }: { settings: WebSettings; update: (next: WebSettings) => Promise<void> }) {
  const { occulta } = useApp();
  const network = occulta.network();
  const [entry, setEntry] = useState('');
  const own = settings.rpcUrls;
  const add = useAction(async () => {
    if (!/^https?:\/\/\S+$/.test(entry)) throw new Error('Enter the endpoint’s http(s) address');
    const chainId = await chainIdAt(entry);
    if (chainId !== network.chainId) throw new Error(`This endpoint serves chain ${chainId}, not ${network.name} (${network.chainId})`);
    await update({ ...settings, rpcUrls: [...own, entry] });
    setEntry('');
  });
  const change = useAction(update);
  // Shown at once; saving it restarts the node, which takes a moment.
  const [fallback, setFallback] = useState(settings.rpcFallback);
  const defaultsUsed = own.length === 0 || fallback;
  return (
    <Card title={`RPC endpoints on ${network.name}`}>
      <p className="muted small">The wallet reads the chain through the first of these that answers, in this order.</p>
      <ul className="rows">
        {own.map((url) => (
          <li key={url} className="row-item">
            <code className="mono break">{url}</code>
            <Button className="ghost small" onClick={() => void change.perform({ ...settings, rpcUrls: own.filter((o) => o !== url) })}>
              Remove
            </Button>
          </li>
        ))}
        {defaultRpcUrls(network).map((url) => (
          <li key={`default-${url}`} className={defaultsUsed ? 'row-item' : 'row-item muted'}>
            <code className="mono break">{url}</code>
            <span className="pill">{defaultsUsed ? 'Network default' : 'Not used'}</span>
          </li>
        ))}
      </ul>
      {own.length > 0 ? (
        <label className="check">
          <input
            type="checkbox"
            checked={fallback}
            onChange={(e) => {
              setFallback(e.target.checked);
              void change.perform({ ...settings, rpcFallback: e.target.checked });
            }}
          />{' '}
          Use the network’s endpoints
          when mine do not answer
        </label>
      ) : null}
      <div className="inline-form">
        <Field label="Add your own">
          <input value={entry} placeholder="https://rpc.example" spellCheck={false} onChange={(e) => setEntry(e.target.value.trim())} />
        </Field>
        <Button className="secondary" busy={add.busy} disabled={!entry || own.includes(entry)} onClick={() => void add.perform()}>
          Add
        </Button>
      </div>
      <ErrorNote error={add.error ?? change.error} />
      <Notice>
        Your RPC provider sees your IP address and the public addresses you check. Add only endpoints you trust: a dishonest one could hide events from your wallet, such as a dispute it has
        to answer.
      </Notice>
    </Card>
  );
}

/** BRD 2.2.11, 2.2.13, 2.2.14.5: the network's RPC endpoints, relayers and relays, with the user's own first. */
function Network() {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const settings = readSettings(occulta);
  const update = async (next: WebSettings) => {
    await writeSettings(occulta, next);
    refresh();
  };
  return (
    <>
      <RpcEndpoints settings={settings} update={update} />
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
    </>
  );
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'Same as this device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** BRD 2.2.14.10: the theme, for this browser. */
function Appearance() {
  const [choice, setChoice] = useState(themeChoice);
  return (
    <Card title="Theme">
      <div className="stack" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <label key={t.id} className="check">
            <input
              type="radio"
              name="theme"
              checked={choice === t.id}
              onChange={() => {
                chooseTheme(t.id);
                setChoice(t.id);
              }}
            />{' '}
            {t.label}
          </label>
        ))}
      </div>
      <p className="muted small">Kept in this browser for every account, and stored unencrypted, since it says nothing about your wallet.</p>
    </Card>
  );
}

const CATEGORIES: { id: SettingsCategory; title: string; text: string; icon: ReactNode }[] = [
  { id: 'accounts', title: 'Accounts', text: 'Switch, add or import accounts', icon: <KeyIcon /> },
  { id: 'backup', title: 'Backup', text: 'Export everything, or restore a file', icon: <ShieldIcon /> },
  { id: 'network', title: 'Network', text: 'RPC endpoints, relayers and relays', icon: <ChannelsIcon /> },
  { id: 'appearance', title: 'Appearance', text: 'Light, dark or like this device', icon: <ThemeIcon /> },
];

/**
 * Settings as categories beside the chosen one (accounts, backup, network, appearance); on phones the list
 * comes first and a category opens on its own. Without a category in the address, wide screens show Accounts.
 */
export function Settings({ category }: { category: SettingsCategory | null }) {
  const { version } = useApp();
  const shown = category ?? 'accounts';
  const current = CATEGORIES.find((c) => c.id === shown) as (typeof CATEGORIES)[number];
  return (
    <div className={category ? 'settings has-detail' : 'settings'} data-version={version}>
      <nav className="settings-menu" aria-label="Settings categories">
        <h1>Settings</h1>
        <ul>
          {CATEGORIES.map((c) => (
            <li key={c.id}>
              <a className={c.id === shown ? 'settings-item on' : 'settings-item'} href={`#/settings/${c.id}`} aria-current={c.id === shown ? 'page' : undefined}>
                <span className="settings-icon">{c.icon}</span>
                <span className="settings-item-text">
                  <strong>{c.title}</strong>
                  <span className="muted small">{c.text}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-detail">
        <header className="page-head only-narrow">
          <a className="icon-button" href="#/settings" aria-label="Back to settings">
            <BackIcon />
          </a>
          <h2>{current.title}</h2>
        </header>
        {shown === 'accounts' ? <Accounts /> : shown === 'backup' ? <Backup /> : shown === 'network' ? <Network /> : <Appearance />}
      </div>
    </div>
  );
}
