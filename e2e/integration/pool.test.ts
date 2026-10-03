// The framework's wallet, pool and relayer services against real contracts on the dev node.
import { beforeAll, describe, expect, it } from 'vitest';
import { parseEther, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ChainAdapter } from '../../packages/framework/src/modules/chain/index.ts';
import { shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import type { RelayerPort } from '../../packages/framework/src/modules/relayer/index.ts';
import { freshDeployment } from './chain.ts';
import { devNetwork, newRelayer, newUser, type User } from './services.ts';

const ETH = 0n;
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  throw new Error('expected an error');
};

describe('pool and relayer services on the dev node', () => {
  let chain: ChainAdapter;
  let usdg: bigint;
  let relayer: Awaited<ReturnType<typeof newRelayer>>;
  let alice: User;
  let bob: User;
  const fees = { eth: parseEther('0.0001'), usdg: 10_000n }; // 0.01 USDG

  beforeAll(async () => {
    const network = devNetwork(await freshDeployment());
    chain = new ChainAdapter(network);
    usdg = BigInt(network.usdg);
    relayer = await newRelayer(network, chain, fees);
    alice = await newUser(network, chain, '2', 500_000_000n);
    bob = await newUser(network, chain);
  });

  it('deposits ETH and USDG from the account and finds both notes', async () => {
    await alice.pool.deposit(ETH, parseEther('0.1'));
    await alice.pool.deposit(usdg, 100_000_000n);
    const balances = alice.pool.balances();
    expect(balances.get(ETH)).toBe(parseEther('0.1'));
    expect(balances.get(usdg)).toBe(100_000_000n);
    expect(await chain.publicBalance(alice.address, usdg)).toBe(400_000_000n);
  });

  it('pays privately through the relayer; the payee and the relayer find their notes', async () => {
    const bobAddress = shieldedAddressOf(await bob.keys.poolKeys());
    await alice.pool.transfer(bobAddress, ETH, parseEther('0.03'), relayer.port);
    await alice.pool.transfer(bobAddress, usdg, 25_000_000n, relayer.port);
    await bob.pool.sync();
    expect(bob.pool.balances().get(ETH)).toBe(parseEther('0.03'));
    expect(bob.pool.balances().get(usdg)).toBe(25_000_000n);
    expect(alice.pool.balances().get(ETH)).toBe(parseEther('0.07') - fees.eth);
    expect(alice.pool.balances().get(usdg)).toBe(75_000_000n - fees.usdg);
    await relayer.user.pool.sync();
    expect(relayer.user.pool.balances().get(ETH)).toBe(fees.eth);
    expect(relayer.user.pool.balances().get(usdg)).toBe(fees.usdg);
  });

  it('withdraws to an address with no history, which needs no ETH of its own', async () => {
    const exit = privateKeyToAccount(generatePrivateKey()).address;
    await bob.pool.withdraw(ETH, parseEther('0.02'), exit, relayer.port);
    await bob.pool.withdraw(usdg, 10_000_000n, exit, relayer.port);
    expect(await chain.publicBalance(exit, ETH)).toBe(parseEther('0.02'));
    expect(await chain.publicBalance(exit, usdg)).toBe(10_000_000n);
    expect(bob.pool.balances().get(ETH)).toBe(parseEther('0.01') - fees.eth);
    expect(bob.pool.balances().get(usdg)).toBe(15_000_000n - fees.usdg);
  });

  it('merges notes automatically when no two notes cover a payment', async () => {
    const carol = await newUser(chain.network, chain, '1');
    for (let i = 0; i < 3; i++) await carol.pool.deposit(ETH, parseEther('0.01'));
    const bobAddress = shieldedAddressOf(await bob.keys.poolKeys());
    // 0.025 ETH + fee needs all three notes: one merge first, then the payment.
    await carol.pool.transfer(bobAddress, ETH, parseEther('0.025'), relayer.port);
    expect(carol.pool.balances().get(ETH)).toBe(parseEther('0.005') - 2n * fees.eth);
  });

  it('refuses what it cannot do: too little money, a relayer that is not paid, a locked wallet', async () => {
    const bobAddress = shieldedAddressOf(await bob.keys.poolKeys());
    expect(await code(alice.pool.transfer(bobAddress, ETH, parseEther('5'), relayer.port))).toBe('INSUFFICIENT_FUNDS');

    // The fee note goes to the relayer named in `info`, but another relayer is asked to submit.
    const other = await newRelayer(chain.network, chain, fees);
    const misdirected: RelayerPort = { info: () => relayer.port.info(), submit: (r) => other.port.submit(r) };
    expect(await code(alice.pool.transfer(bobAddress, ETH, parseEther('0.001'), misdirected))).toBe('NO_FEE_NOTE');

    // A relayer that demands more than the note pays refuses too.
    const greedy = await newRelayer(chain.network, chain, { eth: parseEther('0.01'), usdg: fees.usdg });
    const lowFee: RelayerPort = {
      info: async () => ({ ...(await greedy.port.info()), fees: { [zeroAddress]: fees.eth.toString() } }),
      submit: (r) => greedy.port.submit(r),
    };
    expect(await code(alice.pool.transfer(bobAddress, ETH, parseEther('0.001'), lowFee))).toBe('FEE_TOO_LOW');

    alice.wallet.lock();
    alice.keys.clear();
    expect(await code(alice.pool.transfer(bobAddress, ETH, parseEther('0.001'), relayer.port))).toBe('WALLET_LOCKED');
    await alice.wallet.unlock('password123');
  });
});
