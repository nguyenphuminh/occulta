import { stderr, stdin } from 'node:process';
import { AppError } from '@occulta/framework';

/** Reads a secret from the environment, or from the terminal without echoing it. */
export async function readSecret(envName: string, question: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (!stdin.isTTY) throw new AppError(400, 'SECRET_REQUIRED', `${question.replace(/:\s*$/, '')} is needed: set ${envName} or run in a terminal`);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (done: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      done();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
        if (ch === '\u0003') return finish(() => reject(new AppError(400, 'CANCELLED', 'Cancelled')));
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
