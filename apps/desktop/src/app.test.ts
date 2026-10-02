import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { zeroAddress } from 'viem';
import { BUILT_IN_NETWORKS, ChainAdapter, MemoryStore, Occulta, RelayerService } from '@occulta/framework';
import { createRelayerApp, createRpcApp } from './app.ts';
import { NodeService } from './modules/node/index.ts';
import { createLogger } from './shared/logger.ts';
import { localOnly } from './shared/middlewares/index.ts';

const logger = createLogger('silent');
const TOKEN = 'a'.repeat(64);

async function offlineNode(): Promise<{ occulta: Occulta; node: NodeService }> {
  const occulta = new Occulta({
    store: new MemoryStore(),
    artifacts: async () => ({ wasm: '', zkey: '' }),
    createNode: async () => {
      throw new Error('no libp2p here');
    },
    kdf: { N: 2 ** 10, r: 8, p: 1 },
  });
  await occulta.wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
  await occulta.start();
  return { occulta, node: new NodeService(occulta, { roles: () => ({}) }) };
}

function serve(app: ReturnType<typeof createRpcApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

describe('local RPC server', () => {
  let rpc: { server: Server; url: string };
  let ready = true;
  const call = (command: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${rpc.url}/rpc/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  beforeAll(async () => {
    const { node } = await offlineNode();
    rpc = await serve(createRpcApp({ node, token: TOKEN, logger, ready: () => ready }));
  });
  afterAll(() => new Promise((resolve) => rpc.server.close(resolve)));

  it('rejects calls without the access token or with a wrong one', async () => {
    for (const token of [null, 'b'.repeat(64), 'short']) {
      const res = await call('accounts', {}, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Missing or wrong access token' });
    }
  });

  it('runs commands with the token', async () => {
    const res = await call('accounts', {});
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as { label: string; active: boolean }[];
    expect(accounts).toEqual([expect.objectContaining({ label: 'Account 1', active: true })]);
    const added = await call('account.add', {});
    expect(await added.json()).toMatchObject({ label: 'Account 2', active: false });
    const status = (await (await call('status', {})).json()) as { network: { id: string }; shieldedAddress: string };
    expect(status.network.id).toBe('arbitrum-sepolia');
    expect(status.shieldedAddress).toMatch(/^occ[0-9a-f]{136}$/);
  });

  it('answers with one error format: unknown command, invalid input, invalid JSON, unknown path', async () => {
    expect(await (await call('nope', {})).json()).toMatchObject({ code: 'UNKNOWN_COMMAND' });
    const invalid = await call('deposit', { token: 'doge', amount: 'lots' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_INPUT' });
    const badJson = await call('accounts', '{not json');
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ code: 'INVALID_JSON' });
    const unknown = await fetch(`${rpc.url}/elsewhere`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(unknown.status).toBe(404);
  });

  it('reports health without the token, and 503 while not ready', async () => {
    expect((await fetch(`${rpc.url}/healthz`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${rpc.url}/healthz`)).status).toBe(503);
    ready = true;
  });

  it('refuses connections that do not come from this machine', () => {
    const middleware = localOnly();
    const fake = (remoteAddress: string) => ({ socket: { remoteAddress } }) as never;
    expect(() => middleware(fake('192.168.1.20'), {} as never, () => undefined)).toThrow(/only accepts local connections/);
    let passed = false;
    middleware(fake('::1'), {} as never, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });
});

describe('public relayer server', () => {
  let relayer: { server: Server; url: string };

  beforeAll(async () => {
    const { occulta } = await offlineNode();
    const network = BUILT_IN_NETWORKS.find((n) => n.id === 'arbitrum-sepolia')!;
    const service = new RelayerService(new ChainAdapter(network), {
      account: occulta.wallet.signer(),
      keys: await occulta.keys.poolKeys(),
      fees: { [zeroAddress]: 100n, [network.usdg]: 10n },
    });
    relayer = await serve(createRelayerApp({ relayer: service, logger }));
  });
  afterAll(() => new Promise((resolve) => relayer.server.close(resolve)));

  it('lets the wallet website call it from any origin', async () => {
    const preflight = await fetch(`${relayer.url}/relayer/submit`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('quotes its fees and refuses malformed transactions before touching the chain', async () => {
    const info = (await (await fetch(`${relayer.url}/relayer/info`)).json()) as { fees: Record<string, string>; shieldedAddress: string };
    expect(info.fees[zeroAddress]).toBe('100');
    expect(info.shieldedAddress).toMatch(/^occ/);
    const res = await fetch(`${relayer.url}/relayer/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'transact' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
