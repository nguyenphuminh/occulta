import { useCallback, useEffect, useMemo, useState } from 'react';
import { Channels } from '../modules/channels/index.ts';
import { Onboarding, PhraseNotice, Unlock } from '../modules/onboarding/index.ts';
import { Shielded } from '../modules/pool/index.ts';
import { PublicFunds } from '../modules/public/index.ts';
import { Settings } from '../modules/settings/index.ts';
import { Header } from '../modules/wallet/index.ts';
import { errorText } from '../shared/ui.tsx';
import { AppContext, type AppContextValue } from './context.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { createOcculta } from './node.ts';
import { PromptDialog } from './PromptDialog.tsx';
import { Prompts } from './prompts.ts';
import { startNode } from './settings.ts';

/** How often the unlocked wallet syncs, moves channels forward and watches disputes. */
const TICK_MS = Number(import.meta.env.VITE_OCCULTA_TICK_MS ?? 10_000);

const PAGES = [
  { path: '/', label: 'Public' },
  { path: '/shielded', label: 'Shielded' },
  { path: '/channels', label: 'Channels' },
  { path: '/settings', label: 'Settings' },
] as const;

function useHashPath(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

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

  if (phase === 'loading') return <main className="center">Loading…</main>;
  if (phase === 'onboarding') return <main className="center">{<Onboarding occulta={occulta} onReady={onReady} />}</main>;
  if (phase === 'locked' || !context) return <main className="center">{<Unlock occulta={occulta} onReady={onReady} />}</main>;

  const invite = path.startsWith('/invite/') ? path.slice('/invite/'.length) : '';
  const page = invite ? '/channels' : path;
  return (
    <AppContext.Provider value={context}>
      <Header />
      <nav className="tabs">
        {PAGES.map((p) => (
          <a key={p.path} href={`#${p.path}`} aria-current={page === p.path ? 'page' : undefined}>
            {p.label}
          </a>
        ))}
      </nav>
      <main>
        {problems.length > 0 ? (
          <ul className="problems" aria-label="Background problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <ErrorBoundary key={page} resetKey={version}>
          {page === '/shielded' ? <Shielded /> : page === '/channels' ? <Channels invite={invite} /> : page === '/settings' ? <Settings /> : <PublicFunds />}
        </ErrorBoundary>
      </main>
      <footer>
        <PhraseNotice />
      </footer>
      {prompt ? <PromptDialog prompt={prompt} onAnswer={(answer) => prompts.answer(answer)} /> : null}
    </AppContext.Provider>
  );
}
