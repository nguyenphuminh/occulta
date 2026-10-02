import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChannelsPage, type ChannelsView } from '../modules/channels/index.ts';
import { Home } from '../modules/home/index.ts';
import { Onboarding, PhraseNotice, Unlock } from '../modules/onboarding/index.ts';
import { Deposit, SendPrivately, Withdraw } from '../modules/pool/index.ts';
import { Receive, SendPublic } from '../modules/public/index.ts';
import { Settings } from '../modules/settings/index.ts';
import { AccountBar } from '../modules/wallet/index.ts';
import { ChannelsIcon, HomeIcon, Logo, SettingsIcon } from '../shared/icons.tsx';
import { errorText } from '../shared/ui.tsx';
import { AppContext, type AppContextValue } from './context.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { createOcculta } from './node.ts';
import { PromptDialog } from './PromptDialog.tsx';
import { Prompts } from './prompts.ts';
import { startNode } from './settings.ts';

/** How often the unlocked wallet syncs, moves channels forward and watches disputes. */
const TICK_MS = Number(import.meta.env.VITE_OCCULTA_TICK_MS ?? 10_000);

type Route =
  | { section: 'home'; page: 'home' | 'deposit' | 'send' | 'withdraw' | 'receive' | 'send-public' }
  | { section: 'channels'; view: ChannelsView }
  | { section: 'settings' };

function routeOf(path: string): Route {
  if (path.startsWith('/invite/')) return { section: 'channels', view: { kind: 'open', invite: path.slice('/invite/'.length) } };
  if (path === '/channels/new') return { section: 'channels', view: { kind: 'open', invite: '' } };
  if (path === '/channels/invite') return { section: 'channels', view: { kind: 'invite' } };
  if (path.startsWith('/channels/')) return { section: 'channels', view: { kind: 'channel', id: path.slice('/channels/'.length) } };
  if (path === '/channels') return { section: 'channels', view: { kind: 'none' } };
  if (path === '/settings') return { section: 'settings' };
  const page = path.slice(1);
  return { section: 'home', page: page === 'deposit' || page === 'send' || page === 'withdraw' || page === 'receive' || page === 'send-public' ? page : 'home' };
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
  if (route.section === 'settings') return <Settings />;
  switch (route.page) {
    case 'deposit':
      return <Deposit />;
    case 'send':
      return <SendPrivately />;
    case 'withdraw':
      return <Withdraw />;
    case 'receive':
      return <Receive />;
    case 'send-public':
      return <SendPublic />;
    default:
      return <Home />;
  }
}

const NAV = [
  { section: 'home', href: '#/', label: 'Home', icon: <HomeIcon /> },
  { section: 'channels', href: '#/channels', label: 'Channels', icon: <ChannelsIcon /> },
  { section: 'settings', href: '#/settings', label: 'Settings', icon: <SettingsIcon /> },
] as const;

export function App() {
  const prompts = useMemo(() => new Prompts(), []);
  const occulta = useMemo(() => createOcculta(prompts), [prompts]);
  const [phase, setPhase] = useState<'loading' | 'onboarding' | 'locked' | 'ready'>('loading');
  const [version, setVersion] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(prompts.current());
  const path = useHashPath();
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    void occulta.wallet.exists().then((exists) => setPhase(exists ? 'locked' : 'onboarding'));
    return prompts.subscribe(() => setPrompt(prompts.current()));
  }, [occulta, prompts]);

  const onReady = useCallback(async () => {
    await startNode(occulta);
    setPhase('ready');
    refresh();
  }, [occulta, refresh]);

  const lock = useCallback(async () => {
    await occulta.lock();
    setPhase('locked');
  }, [occulta]);

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

  const context: AppContextValue | null = useMemo(() => (phase === 'ready' ? { occulta, prompts, version, refresh, lock } : null), [phase, occulta, prompts, version, refresh, lock]);

  if (phase === 'loading') return <div className="loading" aria-busy="true" />;
  if (phase === 'onboarding') return <Onboarding occulta={occulta} onReady={onReady} />;
  if (phase === 'locked' || !context) return <Unlock occulta={occulta} onReady={onReady} />;

  const route = routeOf(path);
  return (
    <AppContext.Provider value={context}>
      <div className={`shell section-${route.section}`}>
        <aside className="sidebar">
          <a className="brand" href="#/">
            <Logo size={34} />
            <span>Occulta</span>
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
        <main className="content">
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
          <footer className="footer">
            <PhraseNotice />
          </footer>
        </main>
      </div>
      {prompt ? <PromptDialog prompt={prompt} onAnswer={(answer) => prompts.answer(answer)} /> : null}
    </AppContext.Provider>
  );
}
