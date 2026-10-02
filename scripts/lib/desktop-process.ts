// Runs the real desktop client as a child process, as a user would (integration and UI tests).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { REPO } from './devnode.ts';

const MAIN = join(REPO, 'apps/desktop/src/main.ts');

export interface Ready {
  account: string;
  network: string;
  rpc: { url: string; tokenFile: string } | null;
  relayer: string | null;
  libp2pRelay: string[] | null;
}

export const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

function launch(args: string[], env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Runs a command that exits by itself. */
export function runDesktop(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = launch(args, env);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

/** Starts a node and waits for its "occulta ready" line. */
export function startDesktop(args: string[], env: Record<string, string>): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = launch(args, env);
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
      const line = stdout.split('\n').find((l) => l.startsWith('occulta ready '));
      if (line) resolve({ child, ready: JSON.parse(line.slice('occulta ready '.length)) as Ready });
    });
    child.on('exit', (code) => reject(new Error(`node exited with ${code}: ${stderr}`)));
  });
}

export function stopDesktop(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
}

/** Calls the node's RPC API; a refusal throws an error carrying its code. */
export async function desktopRpc<T>(rpc: { url: string; token: string }, command: string, body: object = {}): Promise<T> {
  const res = await fetch(`${rpc.url}/rpc/${command}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rpc.token}` }, body: JSON.stringify(body) });
  const payload = (await res.json()) as T & { code?: string; message?: string };
  if (!res.ok) throw Object.assign(new Error(payload.message), { code: payload.code, status: res.status });
  return payload;
}
