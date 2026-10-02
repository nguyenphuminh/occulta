import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { RelayerPort } from './modules/relayer/index.ts';
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

  it('switches to another built-in network and rejects an unknown one', async () => {
    const occulta = await node();
    await occulta.wallet.setNetwork('robinhood-testnet');
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

  it('locking stops the services and forgets derived keys', async () => {
    const occulta = await node();
    await occulta.start();
    await occulta.lock();
    expect(() => occulta.pool).toThrow(/start Occulta first/);
    expect(() => occulta.keys.poolKeys()).toThrow(/locked/);
  });
});
