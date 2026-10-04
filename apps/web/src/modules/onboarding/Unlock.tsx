import { useState } from 'react';
import type { Occulta } from '@occulta/framework';
import { ArrowRightIcon } from '../../shared/icons.tsx';
import { Button, Card, ErrorNote, Field, Hero, Notice, useAction } from '../../shared/ui.tsx';
import { AuthLayout, PhraseNotice } from './Onboarding.tsx';

/** BRD 2.2.14.3: a forgotten password is replaced by importing the phrase again, after a warning. */
function ResetWallet({ occulta, onReady, onCancel }: { occulta: Occulta; onReady: () => Promise<void>; onCancel: () => void }) {
  const [understood, setUnderstood] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const reset = useAction(async () => {
    await occulta.wallet.reset(phrase, password);
    await onReady();
  });
  return (
    <AuthLayout back={onCancel}>
      <Card title="Reset the wallet" className="auth-card">
        <Notice tone="warn">
          Resetting restores the accounts of your recovery phrase and, by syncing, their notes. Imported private keys and all channel data are lost unless you also import an export file afterwards.
        </Notice>
        <label className="check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that imported keys and channel data will be lost
        </label>
        {understood ? (
          <div className="stack">
            <PhraseNotice />
            <Field label="Recovery phrase">
              <textarea rows={3} value={phrase} spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
            </Field>
            <Field label="New wallet password">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button className="danger wide" busy={reset.busy} disabled={!phrase || !password} onClick={() => void reset.perform()}>
              Reset wallet
            </Button>
            <ErrorNote error={reset.error} />
          </div>
        ) : null}
      </Card>
    </AuthLayout>
  );
}

/** BRD 2.2.14.3: the wallet is unlocked once per session with its password. */
export function Unlock({ occulta, onReady }: { occulta: Occulta; onReady: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const unlock = useAction(async () => {
    await occulta.wallet.unlock(password);
    await onReady();
  });
  if (resetting) return <ResetWallet occulta={occulta} onReady={onReady} onCancel={() => setResetting(false)} />;
  return (
    <AuthLayout>
      <section className="welcome" aria-label="Unlock">
        <Hero size={180} />
        <h1 className="title">Unlock your wallet</h1>
        <p className="tagline">Your wallet stays locked until you enter its password in this tab.</p>
        <form
          className="unlock-form"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock.perform();
          }}
        >
          <Field label="Wallet password">
            <input type="password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <Button type="submit" className="primary round big" aria-label="Unlock" busy={unlock.busy} disabled={!password}>
            <ArrowRightIcon />
          </Button>
        </form>
        <ErrorNote error={unlock.error} />
        <Button className="link" onClick={() => setResetting(true)}>
          Forgot the password?
        </Button>
      </section>
    </AuthLayout>
  );
}
