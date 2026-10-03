// Test money for the live suite on Arbitrum Sepolia: the key in ~/.occulta-secrets/funder.key sends
// ETH and USDG to the wallets the tests create, and what is left goes back to it afterwards.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatEther, http, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { BUILT_IN_NETWORKS } from '../../packages/framework/src/modules/chain/index.ts';
import { REPO } from '../../scripts/lib/devnode.ts';

export const network = BUILT_IN_NETWORKS.find((n) => n.id === 'arbitrum-sepolia')!;
const chain = defineChain({ id: network.chainId, name: network.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [network.rpcUrl] } } });
export const client = createPublicClient({ chain, transport: http(network.rpcUrl) });
const usdg = network.usdg as Address;

const key = readFileSync(join(homedir(), '.occulta-secrets/funder.key'), 'utf8').trim();
export const funder = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
const funderWallet = createWalletClient({ account: funder, chain, transport: http(network.rpcUrl) });

/** The funder sends one transaction at a time, so parallel funding never reuses a nonce. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(send: () => Promise<T>): Promise<T> {
  const run = queue.then(send);
  queue = run.catch(() => undefined);
  return run;
}

export async function fund(to: Address, eth: string, usdgAmount?: string): Promise<void> {
  await serial(async () => client.waitForTransactionReceipt({ hash: await funderWallet.sendTransaction({ to, value: parseEther(eth) }) }));
  if (usdgAmount) {
    await serial(async () =>
      client.waitForTransactionReceipt({ hash: await funderWallet.writeContract({ address: usdg, abi: erc20Abi, functionName: 'transfer', args: [to, parseUnits(usdgAmount, 6)] }) }),
    );
  }
}

/**
 * Keeps every test wallet's phrase in .occulta/live/test-wallets.jsonl (git-ignored, mode 600), so
 * what a failed run leaves in it can still be withdrawn by importing the phrase on the website.
 */
export function rememberWallet(name: string, phrase: string): void {
  const dir = join(REPO, '.occulta/live');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'test-wallets.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), name, phrase })}\n`, { mode: 0o600 });
}

/** Sends a test wallet's public USDG and ETH (first account) back to the funder; dust that cannot pay its gas stays. */
export async function sweepPublic(phrase: string): Promise<string> {
  const account = mnemonicToAccount(phrase);
  const wallet = createWalletClient({ account, chain, transport: http(network.rpcUrl) });
  const tokens = await client.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  if (tokens > 0n) {
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdg, abi: erc20Abi, functionName: 'transfer', args: [funder.address, tokens] }) });
  }
  const balance = await client.getBalance({ address: account.address });
  const gas = ((await client.estimateGas({ account, to: funder.address, value: 1n })) * 12n) / 10n;
  const maxFeePerGas = (await client.estimateFeesPerGas()).maxFeePerGas * 2n;
  const value = balance - gas * maxFeePerGas;
  if (value <= parseEther('0.0001')) return `${account.address}: ${formatEther(balance)} ETH left (dust)`;
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: funder.address, value, gas, maxFeePerGas, maxPriorityFeePerGas: 0n }) });
  return `${account.address}: returned ${formatEther(value)} ETH`;
}
