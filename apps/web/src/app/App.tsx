import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChannelsPage, PendingOpens, type ChannelsView } from '../modules/channels/index.ts';
import { MyWallet, type WalletDialog } from '../modules/home/index.ts';
import { Onboarding, PhraseBanner, TAGLINE, Unlock } from '../modules/onboarding/index.ts';
import { Settings, type SettingsCategory } from '../modules/settings/index.ts';
import { AccountBar } from '../modules/wallet/index.ts';
import { ChannelsIcon, Logo, SettingsIcon, WalletIcon } from '../shared/icons.tsx';
import { errorText } from '../shared/ui.tsx';
import { AppContext, type AppContextValue } from './context.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { createOcculta } from './node.ts';
import { PromptDialog } from './PromptDialog.tsx';
import { Prompts } from './prompts.ts';
import { startNode } from './settings.ts';

/** How often the unlocked wallet syncs, moves channels forward and watches disputes. */
const TICK_MS = Number(import.meta.env.VITE_OCCULTA_TICK_MS ?? 10_000);

type Route = { section: 'channels'; view: ChannelsView } | { section: 'wallet'; dialog: WalletDialog | null } | { section: 'settings'; category: SettingsCategory | null };

const WALLET_DIALOGS: readonly string[] = ['deposit', 'withdraw', 'receive', 'send'] satisfies WalletDialog[];
const SETTINGS_CATEGORIES: readonly string[] = ['accounts', 'backup', 'network'] satisfies SettingsCategory[];

/** Channels are the product, so they are also where the app opens. */
function routeOf(path: string): Route {
  if (path.startsWith('/invite/')) return { section: 'channels', view: { kind: 'open', invite: path.slice('/invite/'.length) } };
  if (path === '/channels/new') return { section: 'channels', view: { kind: 'open', invite: '' } };
  if (path === '/channels/invite') return { section: 'channels', view: { kind: 'invite' } };
  if (path.startsWith('/channels/')) return { section: 'channels', view: { kind: 'channel', id: path.slice('/channels/'.length) } };
  if (path === '/wallet') return { section: 'wallet', dialog: null };
  if (WALLET_DIALOGS.includes(path.slice(1))) return { section: 'wallet', dialog: path.slice(1) as WalletDialog };
  if (path === '/settings') return { section: 'settings', category: null };
  if (path.startsWith('/settings/') && SETTINGS_CATEGORIES.includes(path.slice('/settings/'.length))) {
    return { section: 'settings', category: path.slice('/settings/'.length) as SettingsCategory };
  }
  return { section: 'channels', view: { kind: 'none' } };
}

function useHashPath(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

function pageOf(route: Route): ReactNode {
  if (route.section === 'channels') return <ChannelsPage view={route.view} />;
  if (route.section === 'settings') return <Settings category={route.category} />;
  return <MyWallet dialog={route.dialog} />;
}

const NAV = [
  { section: 'channels', href: '#/channels', label: 'Channels', icon: <ChannelsIcon /> },
  { section: 'wallet', href: '#/wallet', label: 'My wallet', icon: <WalletIcon /> },
  { section: 'settings', href: '#/settings', label: 'Settings', icon: <SettingsIcon /> },
] as const;

export function App() {
  const prompts = useMemo(() => new Prompts(), []);
  const pendingOpens = useMemo(() => new PendingOpens(), []);
  const occulta = useMemo(() => createOcculta(prompts), [prompts]);
  const [phase, setPhase] = useState<'loading' | 'onboarding' | 'locked' | 'ready'>('loading');
  const [version, setVersion] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [asked, setAsked] = useState(prompts.current());
  const path = useHashPath();
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    void occulta.wallet.exists().then((exists) => setPhase(exists ? 'locked' : 'onboarding'));
    return prompts.subscribe(() => {
      setAsked(prompts.current());
      refresh(); // channel requests also show in the channel list
    });
  }, [occulta, prompts, refresh]);

  useEffect(() => pendingOpens.subscribe(refresh), [pendingOpens, refresh]);

  const onReady = useCallback(async () => {
    await startNode(occulta);
    setPhase('ready');
    refresh();
  }, [occulta, refresh]);

  const lock = useCallback(async () => {
    await occulta.lock();
    setPhase('locked');
    pendingOpens.clear(); // after the wallet screen is gone: its redraw would ask the stopped node for channels
  }, [occulta, pendingOpens]);

  useEffect(() => {
    if (phase !== 'ready') return;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      occulta
        .tick()
        .then((found) => setProblems(found.map((p) => `Channel ${p.channelId.slice(0, 8)}: ${errorText(p.error)}`)))
        .catch((err: unknown) => setProblems([errorText(err)]))
        .finally(() => {
          running = false;
          refresh();
        });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [phase, occulta, refresh]);

  const context: AppContextValue | null = useMemo(
    () => (phase === 'ready' ? { occulta, prompts, pendingOpens, version, refresh, lock } : null),
    [phase, occulta, prompts, pendingOpens, version, refresh, lock],
  );

  if (phase === 'loading') return <div className="loading" aria-busy="true" />;
  if (phase === 'onboarding') return <Onboarding occulta={occulta} onReady={onReady} />;
  if (phase === 'locked' || !context) return <Unlock occulta={occulta} onReady={onReady} />;

  const route = routeOf(path);
  return (
    <AppContext.Provider value={context}>
      <div className={`shell section-${route.section}${route.section === 'channels' && route.view.kind === 'channel' ? ' chat-open' : ''}`}>
        <aside className="sidebar">
          <a className="brand" href="#/channels">
            <Logo size={34} />
            <span className="brand-text">
              <span>Occulta</span>
              <small className="brand-tagline">{TAGLINE}</small>
            </span>
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.section} href={n.href} aria-current={route.section === n.section ? 'page' : undefined}>
                {n.icon}
                <span>{n.label}</span>
              </a>
            ))}
          </nav>
          <AccountBar />
        </aside>
        <main className={route.section === 'channels' ? 'content full' : 'content'}>
          <PhraseBanner />
          {problems.length > 0 ? (
            <ul className="problems" aria-label="Background problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <ErrorBoundary key={route.section} resetKey={version}>
            {pageOf(route)}
          </ErrorBoundary>
        </main>
      </div>
      {asked ? <PromptDialog asked={asked} /> : null}
    </AppContext.Provider>
  );
}
