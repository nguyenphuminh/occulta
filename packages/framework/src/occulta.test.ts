import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { BUILT_IN_NETWORKS } from './modules/chain/index.ts';
import type { RelayerPort } from './modules/relayer/index.ts';
import type { PoolRepository } from './modules/pool/index.ts';
import { MemoryStore } from './modules/storage/index.ts';
import { Occulta, type OccultaOptions } from './occulta.ts';

const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const fixedRelayer = (ethFee: bigint): RelayerPort => ({
  info: async () => ({ chainId: 421614, shieldedAddress: 'occ', fees: { [zeroAddress]: ethFee.toString() } }),
  submit: async () => ({ txHash: '0x01' }),
});

async function node(options: Partial<OccultaOptions> = {}): Promise<Occulta> {
  const occulta = new Occulta({
    store: new MemoryStore(),
    artifacts: async () => ({ wasm: '', zkey: '' }),
    createNode: async () => {
      throw new Error('no libp2p in this test');
    },
    kdf: FAST_KDF,
    // Offline: none of the network's own relayers or relays, whatever its configuration lists.
    relayers: [],
    libp2pRelays: [],
    ...options,
  });
  await occulta.wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
  return occulta;
}

describe('Occulta facade', () => {
  it('needs start() before network services, and starts without channels when no libp2p relay is known', async () => {
    const occulta = await node();
    expect(() => occulta.pool).toThrow(/start Occulta first/);
    await occulta.start();
    expect(occulta.network().id).toBe('arbitrum-sepolia');
    expect(occulta.pool).toBeDefined();
    expect(() => occulta.channels).toThrow(/libp2p relay/);
  });

  it('switches to another configured network and rejects an unknown one', async () => {
    const other = { ...(BUILT_IN_NETWORKS[0] as (typeof BUILT_IN_NETWORKS)[number]), id: 'other', chainId: 46630 };
    const occulta = await node({ networks: [...BUILT_IN_NETWORKS, other] });
    await occulta.wallet.setNetwork('other');
    await occulta.start();
    expect(occulta.chain.network.chainId).toBe(46630);
    await occulta.wallet.setNetwork('nowhere');
    await expect(occulta.start()).rejects.toMatchObject({ code: 'UNKNOWN_NETWORK' });
  });

  it('uses the configured relayer and refuses quotes above the maximum fee', async () => {
    const occulta = await node({ relayers: [fixedRelayer(500n)], maxFee: new Map([[0n, 400n]]) });
    await occulta.start();
    await expect(occulta.relayer().info()).rejects.toMatchObject({ code: 'FEE_ABOVE_MAX' });
    const cheap = await node({ relayers: [fixedRelayer(300n)], maxFee: new Map([[0n, 400n]]) });
    await cheap.start();
    expect((await cheap.relayer().info()).fees[zeroAddress]).toBe('300');
    const none = await node();
    await none.start();
    expect(() => none.relayer()).toThrow(/No transaction relayer/);
  });

  it('applies changed settings from the next start', async () => {
    const occulta = await node();
    await occulta.start();
    expect(() => occulta.relayer()).toThrow(/No transaction relayer/);
    occulta.configure({ relayers: [fixedRelayer(1n)] });
    await occulta.start();
    expect((await occulta.relayer().info()).fees[zeroAddress]).toBe('1');
  });

  it('closes a session’s stores when it ends, so its unfinished work never overwrites the next session’s data', async () => {
    const occulta = await node();
    const storeOf = () => (occulta.pool as unknown as { deps: { repository: PoolRepository } }).deps.repository;
    await occulta.start();
    const first = storeOf();
    await occulta.start(); // as after switching account or network
    const second = storeOf();
    await second.save({ syncedBlock: 42n, notes: [] });
    await expect(first.save({ syncedBlock: 7n, notes: [] })).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    await occulta.lock();
    await occulta.wallet.unlock('password123');
    await occulta.start();
    await expect(second.save({ syncedBlock: 9n, notes: [] })).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    expect(storeOf().load().syncedBlock).toBe(42n);
  });

  it('reads the chain through the user’s own RPC endpoints first, then the network’s unless that is turned off', async () => {
    const occulta = await node();
    const defaults = ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com', 'https://arbitrum-sepolia.gateway.tenderly.co'];
    expect(occulta.rpcUrls()).toEqual(defaults);
    occulta.configure({ rpcUrls: ['https://mine.example', defaults[1] as string] });
    expect(occulta.rpcUrls()).toEqual(['https://mine.example', defaults[1], defaults[0], defaults[2]]);
    occulta.configure({ rpcFallback: false });
    expect(occulta.rpcUrls()).toEqual(['https://mine.example', defaults[1]]);
    occulta.configure({ rpcUrls: [] });
    expect(occulta.rpcUrls()).toEqual(defaults); // with none of their own, the network's are used
  });

  it('locking stops the services and forgets derived keys', async () => {
    const occulta = await node();
    await occulta.start();
    await occulta.lock();
    expect(() => occulta.pool).toThrow(/start Occulta first/);
    expect(() => occulta.keys.poolKeys()).toThrow(/locked/);
  });
});
