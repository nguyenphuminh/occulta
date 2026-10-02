import { useState } from 'react';
import type { Occulta } from '@occulta/framework';
import { Button, Card, ErrorNote, Field, Notice, useAction } from '../../shared/ui.tsx';
import { PhraseNotice } from './Onboarding.tsx';

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
    <Card title="Reset the wallet">
      <Notice tone="warn">
        Resetting restores the accounts of your recovery phrase and, by syncing, their notes. Imported private keys and all channel data are lost unless you also import an
        export file afterwards.
      </Notice>
      <label className="check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that imported keys and channel data will be lost
      </label>
      {understood ? (
        <>
          <PhraseNotice />
          <Field label="Recovery phrase">
            <textarea rows={3} value={phrase} spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
          </Field>
          <Field label="New wallet password">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button busy={reset.busy} disabled={!phrase || !password} onClick={() => void reset.perform()}>
            Reset wallet
          </Button>
          <ErrorNote error={reset.error} />
        </>
      ) : null}
      <Button className="secondary" onClick={onCancel}>
        Back
      </Button>
    </Card>
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
    <Card title="Unlock your wallet">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void unlock.perform();
        }}
      >
        <Field label="Wallet password">
          <input type="password" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <ErrorNote error={unlock.error} />
        <Button type="submit" busy={unlock.busy} disabled={!password}>
          Unlock
        </Button>
      </form>
      <Button className="link" onClick={() => setResetting(true)}>
        Forgot the password?
      </Button>
    </Card>
  );
}
