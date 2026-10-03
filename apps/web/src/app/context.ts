import { createContext, useContext } from 'react';
import type { Occulta } from '@occulta/framework';
import type { PendingOpens } from '../modules/channels/pendingOpens.ts';
import type { Prompts } from './prompts.ts';

export interface AppContextValue {
  occulta: Occulta;
  prompts: Prompts;
  /** Channels being opened from this tab, shown while the other side decides. */
  pendingOpens: PendingOpens;
  /** Changes whenever wallet data may have changed (after an action or a background check). */
  version: number;
  refresh: () => void;
  lock: () => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp outside the unlocked app');
  return value;
}
