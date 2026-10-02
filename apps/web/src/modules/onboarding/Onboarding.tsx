import { useState, type ReactNode } from 'react';
import { MIN_PASSWORD_LENGTH, type Occulta } from '@occulta/framework';
import { ChannelsIcon, KeyIcon, ShieldIcon } from '../../shared/icons.tsx';
import { Button, Card, ErrorNote, Field, Glows, Hero, Notice, useAction } from '../../shared/ui.tsx';

/** BRD 2.2.14: the website states this wherever a phrase could be asked for. */
export function PhraseNotice() {
  return <Notice tone="warn">Occulta only ever asks for your recovery phrase when you import a wallet. Never type it anywhere else.</Notice>;
}

/** Full-screen layout of the screens shown before the wallet is unlocked. */
export function AuthLayout({ children, back }: { children: ReactNode; back?: () => void }) {
  return (
    <div className="auth">
      <Glows />
      <div className="auth-column">
        {back ? (
          <button type="button" className="link back-link" onClick={back}>
            ← Back
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function PasswordFields({ onSubmit, busy, label }: { onSubmit: (password: string) => void; busy: boolean; label: string }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const problem =
    password.length > 0 && password.length < MIN_PASSWORD_LENGTH
      ? `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`
      : repeat.length > 0 && repeat !== password
        ? 'The passwords do not match.'
        : null;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && password === repeat) onSubmit(password);
      }}
    >
      <Field label="Wallet password" hint="It encrypts everything this website stores. It cannot be recovered.">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Repeat the password">
        <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
      </Field>
      <ErrorNote error={problem} />
      <Button type="submit" className="primary wide" busy={busy} disabled={!password || password !== repeat || password.length < MIN_PASSWORD_LENGTH}>
        {label}
      </Button>
    </form>
  );
}

/** BRD 2.2.14.1: a new phrase is shown once; 3 of its words must be re-entered before the wallet exists. */
function CreateWallet({ occulta, onReady }: { occulta: Occulta; onReady: () => Promise<void> }) {
  const { wallet } = occulta;
  const [phrase, setPhrase] = useState(() => wallet.generatePhrase());
  const [step, setStep] = useState<'show' | 'confirm' | 'password'>('show');
  const [saved, setSaved] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState(false);
  const create = useAction(async (password: string) => {
    await wallet.createFromPhrase(phrase, password);
    await onReady();
  });

  if (step === 'show') {
    return (
      <Card title="Your recovery phrase" className="auth-card">
        <p className="muted">Write these 12 words down in order and keep them offline. They are shown only this once, and they are the only way to recover this wallet.</p>
        <ol className="phrase" aria-label="Recovery phrase">
          {phrase.split(' ').map((word, i) => (
            <li key={i}>
              <span className="phrase-index">{String(i + 1).padStart(2, '0')}</span>
              <span className="phrase-word">{word}</span>
            </li>
          ))}
        </ol>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have written my recovery phrase down
        </label>
        <Button
          className="primary wide"
          disabled={!saved}
          onClick={() => {
            setPositions(wallet.pickConfirmationWords());
            setStep('confirm');
          }}
        >
          I wrote it down
        </Button>
      </Card>
    );
  }
  if (step === 'confirm') {
    return (
      <Card title="Confirm your recovery phrase" className="auth-card">
        <p className="muted">Type the requested words, so we know the phrase is written down correctly.</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (wallet.confirmWords(phrase, answers)) setStep('password');
            else setWrong(true);
          }}
        >
          <div className="word-inputs">
            {positions.map((p) => (
              <Field key={p} label={`Word #${p + 1}`}>
                <input value={answers[p] ?? ''} autoComplete="off" onChange={(e) => setAnswers({ ...answers, [p]: e.target.value })} />
              </Field>
            ))}
          </div>
          <ErrorNote error={wrong ? 'Those words do not match your phrase. Try again.' : null} />
          <Button type="submit" className="primary wide">
            Confirm words
          </Button>
          <Button
            className="ghost wide"
            onClick={() => {
              setPhrase(wallet.generatePhrase());
              setAnswers({});
              setWrong(false);
              setSaved(false);
              setStep('show');
            }}
          >
            Start over with a new phrase
          </Button>
        </form>
      </Card>
    );
  }
  return (
    <Card title="Set the wallet password" className="auth-card">
      <PasswordFields label="Create wallet" busy={create.busy} onSubmit={(password) => void create.perform(password)} />
      <ErrorNote error={create.error} />
    </Card>
  );
}

/** BRD 2.2.14.1: a standard recovery phrase or a single private key. */
function ImportWallet({ occulta, onReady }: { occulta: Occulta; onReady: () => Promise<void> }) {
  const [secret, setSecret] = useState('');
  const isKey = /^(0x)?[0-9a-fA-F]{64}$/.test(secret.trim());
  const importIt = useAction(async (password: string) => {
    if (isKey) await occulta.wallet.importPrivateKey(secret.trim(), password);
    else await occulta.wallet.createFromPhrase(secret, password);
    await onReady();
  });
  return (
    <Card title="Import a wallet" className="auth-card">
      <PhraseNotice />
      <Field label="Recovery phrase or private key">
        <textarea rows={3} value={secret} autoComplete="off" spellCheck={false} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <PasswordFields label="Import wallet" busy={importIt.busy} onSubmit={(password) => void importIt.perform(password)} />
      <ErrorNote error={importIt.error} />
    </Card>
  );
}

/** BRD 2.2.14.6: restores everything from an export file with its password. */
export function RestoreWallet({ occulta, onReady }: { occulta: Occulta; onReady: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const restore = useAction(async () => {
    await occulta.wallet.importFile(await (file as File).text(), password);
    await onReady();
  });
  return (
    <Card title="Restore from an export file" className="auth-card">
      <Field label="Export file">
        <input type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Password of the export file">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button className="primary wide" busy={restore.busy} disabled={!file || !password} onClick={() => void restore.perform()}>
        Restore
      </Button>
      <ErrorNote error={restore.error} />
    </Card>
  );
}

const FEATURES = [
  { icon: <ShieldIcon />, title: 'Private by default', text: 'Your funds sit in a shared pool. Payments inside it reveal no sender, recipient or amount.' },
  { icon: <KeyIcon />, title: 'Your keys stay here', text: 'Keys are made in this browser and stored only encrypted with your password. Nobody can recover them for you.' },
  { icon: <ChannelsIcon />, title: 'Instant channel payments', text: 'Open a channel with someone and pay back and forth off-chain, with no transaction per payment.' },
];

/** First visit: create, import or restore a wallet (BRD 2.2.14.1). */
export function Onboarding({ occulta, onReady }: { occulta: Occulta; onReady: () => Promise<void> }) {
  const [mode, setMode] = useState<'choose' | 'create' | 'import' | 'restore'>('choose');
  const back = () => setMode('choose');
  if (mode === 'create')
    return (
      <AuthLayout back={back}>
        <CreateWallet occulta={occulta} onReady={onReady} />
      </AuthLayout>
    );
  if (mode === 'import')
    return (
      <AuthLayout back={back}>
        <ImportWallet occulta={occulta} onReady={onReady} />
      </AuthLayout>
    );
  if (mode === 'restore')
    return (
      <AuthLayout back={back}>
        <RestoreWallet occulta={occulta} onReady={onReady} />
      </AuthLayout>
    );
  return (
    <AuthLayout>
      <section className="welcome" aria-label="Welcome to Occulta">
        <Hero />
        <h1 className="display">Occulta</h1>
        <p className="tagline">Private payments and payment channels on Arbitrum, with a wallet built into this page.</p>
        <div className="features">
          {FEATURES.map((f, i) => (
            <details key={f.title} className="feature" open={i === 0}>
              <summary>
                <span className="feature-icon">{f.icon}</span>
                <strong>{f.title}</strong>
              </summary>
              <p>{f.text}</p>
            </details>
          ))}
        </div>
        <div className="stack">
          <Button className="primary wide tall" onClick={() => setMode('create')}>
            Create a new wallet
          </Button>
          <Button className="secondary wide tall" onClick={() => setMode('import')}>
            Import a recovery phrase or private key
          </Button>
          <Button className="ghost wide" onClick={() => setMode('restore')}>
            Restore from an export file
          </Button>
        </div>
        <PhraseNotice />
      </section>
    </AuthLayout>
  );
}
