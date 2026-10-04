import { destination, pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs on stderr, so they never mix with command results on stdout. */
export function createLogger(level: string): Logger {
  return pino({ level, base: { app: 'occulta-desktop' } }, destination(2));
}
