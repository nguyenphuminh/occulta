/**
 * BRD 2.2.14.10: light or dark like the device, unless the user chose one in Settings. The choice
 * belongs to the browser, not to a wallet, and is the one thing kept unencrypted; index.html
 * applies it before the first paint.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'occulta.theme';
const deviceDark = window.matchMedia('(prefers-color-scheme: dark)');

function saved(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

// Also kept here, so a browser that refuses storage keeps the choice until the page closes.
let choice: ThemeChoice = saved();

function apply(): void {
  document.documentElement.dataset.theme = choice === 'system' ? (deviceDark.matches ? 'dark' : 'light') : choice;
}

export const themeChoice = (): ThemeChoice => choice;

export function chooseTheme(next: ThemeChoice): void {
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage refused, as in some private windows: the choice lasts until the page closes.
  }
  apply();
}

/** Applies the choice, then follows the device whenever the choice is the device's. */
export function followTheme(): void {
  apply();
  deviceDark.addEventListener('change', apply);
}
