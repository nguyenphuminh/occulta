import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { isAppError, isRoundAmount, quotedFee, type RelayerPort } from '@occulta/framework';
import { formatAmount, parseAmount, SYMBOL, type TokenName } from './amounts.ts';

export function errorText(err: unknown): string {
  if (isAppError(err)) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Runs an async action with busy and error state. */
export function useAction<A extends unknown[], T>(run: (...args: A) => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = useCallback(
    async (...args: A): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        return await run(...args);
      } catch (err) {
        setError(errorText(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [run],
  );
  return { busy, error, perform, setError };
}

/** Loads data whenever `key` changes; a failed load keeps the previous data and reports the error. */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const run = ++latest.current;
    loader.current().then(
      (data) => run === latest.current && setState({ data, error: null }),
      (err: unknown) => run === latest.current && setState((s) => ({ data: s.data, error: errorText(err) })),
    );
  }, [key]);
  return state;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** A labelled form control: the label names exactly the control, and the hint describes it. */
export function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint ? (
        <small id={`${id}-hint`} className="hint">
          {hint}
        </small>
      ) : null}
    </div>
  );
}

export function Button({ busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? 'Working…' : children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  return <p className={`notice ${tone}`}>{children}</p>;
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Qr({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(text, { margin: 1, width: 192 }).then(setSrc);
  }, [text]);
  return src ? <img className="qr" src={src} alt={label} width={192} height={192} /> : null;
}

export function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Amount input with presets in powers of ten and the round-amount hint (BRD 2.2.2, 2.2.5): a hint, never a block. */
export function AmountField({
  label,
  token,
  value,
  onChange,
  presets,
}: {
  label: string;
  token: TokenName;
  value: string;
  onChange: (value: string) => void;
  presets?: readonly bigint[];
}) {
  const parsed = parseAmount(token, value);
  const hint =
    value && parsed === null
      ? 'Enter a positive amount.'
      : presets && parsed !== null && !isRoundAmount(parsed)
        ? 'Round amounts (1, 10, 100…) are harder to trace. You can continue anyway.'
        : undefined;
  return (
    <div className="amount">
      {presets ? (
        <span className="presets" aria-label="Preset amounts">
          {presets.map((p) => {
            const text = formatAmount(token, p).split(' ')[0] as string;
            return (
              <button key={text} type="button" className={value === text ? 'chip on' : 'chip'} onClick={() => onChange(text)}>
                {text}
              </button>
            );
          })}
        </span>
      ) : null}
      <Field label={`${label} (${SYMBOL[token]})`} hint={hint}>
        <input inputMode="decimal" value={value} placeholder="0.0" onChange={(e) => onChange(e.target.value)} />
      </Field>
    </div>
  );
}

/**
 * Submit button of an action that goes through a relayer (BRD 2.2.11): it first shows the
 * relayer's quoted fee next to what will happen, and submits only once the user confirms.
 */
export function RelayedSubmit({
  label,
  token,
  tokenId,
  disabled,
  relayer,
  details,
  run,
  onDone,
}: {
  label: string;
  token: TokenName;
  tokenId: bigint;
  disabled?: boolean;
  relayer: () => RelayerPort;
  details: ReactNode;
  run: (relayer: RelayerPort) => Promise<unknown>;
  onDone?: () => void;
}) {
  const [review, setReview] = useState<{ port: RelayerPort; fee: bigint } | null>(null);
  const quote = useAction(async () => {
    const port = relayer();
    setReview({ port, fee: quotedFee(await port.info(), tokenId) });
  });
  const submit = useAction(async (port: RelayerPort) => {
    await run(port);
    setReview(null);
    onDone?.();
  });
  return (
    <>
      <Button disabled={disabled} busy={quote.busy} onClick={() => void quote.perform()}>
        {label}
      </Button>
      <ErrorNote error={quote.error} />
      {review ? (
        <Modal title={`Confirm: ${label}`}>
          {details}
          <p>
            Relayer fee: <strong>{formatAmount(token, review.fee)}</strong> (paid privately from your notes)
          </p>
          <ErrorNote error={submit.error} />
          <div className="row">
            <Button busy={submit.busy} onClick={() => void submit.perform(review.port)}>
              Confirm
            </Button>
            <Button className="secondary" disabled={submit.busy} onClick={() => setReview(null)}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
