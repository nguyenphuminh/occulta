// RPC endpoints (BRD 2.2.13, 2.2.14.5): the user's own first, the network's after them, through
// proxies in front of the dev node that go down, serve another chain, limit event queries, lag
// behind or lose receipts.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { DEVNODE_RPC } from '../../scripts/lib/devnode.ts';
import { freshDeployment } from './chain.ts';
import { devNetwork, newUser } from './services.ts';

const ETH = 0n;
type Request = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };

/** A JSON-RPC proxy in front of the dev node whose behaviour the test changes as it goes. */
interface Proxy {
  url: string;
  mode: 'forward' | 'down' | 'wrong-chain' | 'fail-logs' | 'drop-receipts';
  /** Refuses event queries over more blocks than this. */
  maxRange: bigint | null;
  /** Reports a head this many blocks behind, and no events after it. */
  lag: bigint;
  methods: string[];
}

const servers: { close(): void }[] = [];

async function proxy(): Promise<Proxy> {
  const forward = async (r: Request) =>
    (await (await fetch(DEVNODE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) })).json()) as { result?: unknown; error?: unknown };
  const head = async (p: Proxy) => BigInt((await forward({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] })).result as string) - p.lag;
  const p: Proxy = { url: '', mode: 'forward', maxRange: null, lag: 0n, methods: [] };
  const answer = async (r: Request): Promise<object> => {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: r.id, result });
    if (p.mode === 'wrong-chain' && r.method === 'eth_chainId') return ok('0x1');
    if ((p.mode === 'fail-logs' && r.method === 'eth_getLogs') || (p.mode === 'drop-receipts' && r.method === 'eth_getTransactionReceipt')) throw new Error('drop');
    if (r.method === 'eth_getLogs') {
      const { fromBlock, toBlock } = r.params[0] as { fromBlock: string; toBlock: string };
      if (p.maxRange !== null && BigInt(toBlock) - BigInt(fromBlock) + 1n > p.maxRange) return { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: `query exceeds max block range ${p.maxRange}` } };
      if (p.lag > 0n) {
        const top = await head(p);
        const logs = ((await forward(r)).result as { blockNumber: string }[]).filter((l) => BigInt(l.blockNumber) <= top);
        return ok(logs);
      }
    }
    if (r.method === 'eth_blockNumber' && p.lag > 0n) return ok(`0x${(await head(p)).toString(16)}`);
    return { ...(await forward(r)), id: r.id };
  };
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Request | Request[];
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      p.methods.push(...batch.map((r) => r.method));
      if (p.mode === 'down') {
        res.writeHead(503).end('down');
        return;
      }
      Promise.all(batch.map(answer)).then(
        (results) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(parsed) ? results : results[0])),
        () => res.destroy(),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  p.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return p;
}

describe('RPC endpoints', () => {
  let network: NetworkConfig;
  let direct: ChainAdapter;
  let deployBlock: bigint;
  /** Commitments and nullifiers of the whole history, as one endpoint reports them. */
  const history = async (chain: ChainAdapter) => {
    const { commitments, nullifiers } = await chain.poolEvents(deployBlock);
    return { commitments: commitments.map((c) => c.commitment), nullifiers };
  };

  beforeAll(async () => {
    network = devNetwork(await freshDeployment());
    direct = new ChainAdapter(network);
    deployBlock = network.contracts!.deployBlock;
    const user = await newUser(network, direct, '1');
    for (let i = 0; i < 3; i++) await user.pool.deposit(ETH, parseEther('0.01'));
  });

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it('reads the whole history from an endpoint that limits event queries, in smaller windows', async () => {
    const limited = await proxy();
    limited.maxRange = 8n;
    const chain = new ChainAdapter(network, { rpcUrls: [limited.url], logWindow: 64n, minLogWindow: 2n });
    const expected = await history(direct);
    expect(expected.commitments).toHaveLength(3);
    expect(await history(chain)).toEqual(expected);
    expect(limited.methods.filter((m) => m === 'eth_getLogs').length).toBeGreaterThan(2);
  });

  it('uses the next endpoint while one is down, and the preferred one again once it answers', async () => {
    const [first, second] = [await proxy(), await proxy()];
    first.mode = 'down';
    const chain = new ChainAdapter(network, { rpcUrls: [first.url, second.url], retryAfterMs: 500 });
    expect(await chain.latestBlock()).toBeGreaterThan(0n);
    expect(second.methods).toContain('eth_blockNumber');
    first.methods.length = 0;
    await chain.latestBlock();
    expect(first.methods).toEqual([]); // passed over for a while
    first.mode = 'forward';
    await new Promise((r) => setTimeout(r, 600));
    second.methods.length = 0;
    await chain.latestBlock();
    expect(first.methods).toContain('eth_blockNumber');
    expect(second.methods).toEqual([]);
  });

  it('never trusts an endpoint of another chain', async () => {
    const [wrong, right] = [await proxy(), await proxy()];
    wrong.mode = 'wrong-chain';
    const chain = new ChainAdapter(network, { rpcUrls: [wrong.url, right.url] });
    expect(await history(chain)).toEqual(await history(direct));
    expect(wrong.methods).toEqual(['eth_chainId']);
    await chain.latestBlock();
    expect(wrong.methods).toEqual(['eth_chainId']); // never asked again
  });

  it('keeps a sync on one endpoint, so one that lags behind never makes the wallet skip a note', async () => {
    const [ahead, behind] = [await proxy(), await proxy()];
    const chain = new ChainAdapter(network, { rpcUrls: [ahead.url, behind.url] });
    const user = await newUser(network, chain, '1');
    await user.pool.deposit(ETH, parseEther('0.01'));
    expect(user.pool.balances().get(ETH)).toBe(parseEther('0.01'));

    // The preferred endpoint knows the newest block but cannot answer event queries; the other one lags.
    behind.lag = 50n;
    ahead.mode = 'fail-logs';
    await user.pool.deposit(ETH, parseEther('0.01')).catch(() => undefined); // its closing sync cannot finish yet
    await user.pool.sync();
    // Mixing the head of one with the events of the other would skip the new note for good.
    expect(user.pool.balances().get(ETH)).toBe(parseEther('0.01'));
    behind.lag = 0n;
    await user.pool.sync();
    expect(user.pool.balances().get(ETH)).toBe(parseEther('0.02'));
  });

  it('fails plainly when no endpoint answers', async () => {
    const down = await proxy();
    down.mode = 'down';
    const chain = new ChainAdapter(network, { rpcUrls: [down.url] });
    await expect(chain.latestBlock()).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });

  it('never sends a deposit again through another endpoint, even when the first loses its receipt', async () => {
    const [flaky, other] = [await proxy(), await proxy()];
    const chain = new ChainAdapter(network, { rpcUrls: [flaky.url, other.url] });
    const user = await newUser(network, chain, '1');
    const before = (await history(direct)).commitments.length;
    flaky.mode = 'drop-receipts';
    await expect(user.pool.deposit(ETH, parseEther('0.01'))).rejects.toThrow();
    expect(other.methods).not.toContain('eth_sendRawTransaction');
    await expect.poll(async () => (await history(direct)).commitments.length, { timeout: 30_000 }).toBe(before + 1); // it went through once
  });
});
