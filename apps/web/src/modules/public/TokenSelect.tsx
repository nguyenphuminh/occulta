import { SYMBOL, TOKENS, type TokenName } from '../../shared/amounts.ts';
import { Field } from '../../shared/ui.tsx';

export function TokenSelect({ value, onChange }: { value: TokenName; onChange: (t: TokenName) => void }) {
  return (
    <Field label="Token">
      <select value={value} onChange={(e) => onChange(e.target.value as TokenName)}>
        {TOKENS.map((t) => (
          <option key={t} value={t}>
            {SYMBOL[t]}
          </option>
        ))}
      </select>
    </Field>
  );
}
