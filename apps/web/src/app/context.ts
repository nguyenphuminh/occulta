import { createContext, useContext } from 'react';
import type { Occulta } from '@occulta/framework';
import type { Prompts } from './prompts.ts';

export interface AppContextValue {
  occulta: Occulta;
  prompts: Prompts;
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
