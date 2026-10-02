// Builds the Occulta Stylus contracts and deploys them, doing what `cargo stylus deploy` does
// (cargo-stylus itself needs OpenSSL headers this machine lacks): build for wasm32, round-trip the
// module through text to drop reference-type leftovers, strip custom sections, brotli-compress,
// prefix 0xEFF00000, deploy behind a small EVM prelude, then activate via the ArbWasm precompile.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { BaseError, bytesToHex, concat, numberToHex, parseAbi, parseEther, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { disputesAbi, poolAbi } from '../../packages/framework/src/modules/chain/chain.abi.ts';
import { REPO } from './devnode.ts';

export const CONTRACTS = ['verifier', 'hasher', 'pool', 'disputes'] as const;
export type ContractName = (typeof CONTRACTS)[number];
/** Stylus programs are limited to 24 KiB compressed, like EVM code. */
export const MAX_CODE_SIZE = 24 * 1024;

const CONTRACTS_DIR = join(REPO, 'contracts');
const ARB_WASM: Address = '0x0000000000000000000000000000000000000071';
const arbWasmAbi = parseAbi(['function activateProgram(address program) payable returns (uint16 version, uint256 dataFee)']);

export interface BuiltContract {
  name: ContractName;
  /** On-chain code: 0xEFF00000 followed by the brotli-compressed wasm. */
  code: Uint8Array;
}

/** `e2e` builds the Disputes contract with the short dispute window used by dev-node tests. */
export function buildContracts({ e2e = false } = {}): BuiltContract[] {
  const targetDir = join(CONTRACTS_DIR, 'target', e2e ? 'e2e' : 'release-wasm');
  const args = ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown', '--target-dir', targetDir];
  for (const name of CONTRACTS) args.push('-p', `occulta-${name}`);
  if (e2e) args.push('--features', 'occulta-disputes/e2e-short-window');
  execFileSync('cargo', args, { cwd: CONTRACTS_DIR, stdio: ['ignore', 'ignore', 'inherit'] });

  const work = mkdtempSync(join(tmpdir(), 'occulta-wasm-'));
  try {
    return CONTRACTS.map((name) => {
      const wasm = join(targetDir, 'wasm32-unknown-unknown/release', `occulta_${name}.wasm`);
      const wat = join(work, `${name}.wat`);
      const roundTripped = join(work, `${name}.rt.wasm`);
      const stripped = join(work, `${name}.wasm`);
      execFileSync('wasm-tools', ['print', wasm, '-o', wat]);
      execFileSync('wasm-tools', ['parse', wat, '-o', roundTripped]);
      execFileSync('wasm-tools', ['strip', '--all', roundTripped, '-o', stripped]);
      const compressed = brotliCompressSync(readFileSync(stripped), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 22 },
      });
      const code = new Uint8Array([0xef, 0xf0, 0x00, 0x00, ...compressed]);
      if (code.length > MAX_CODE_SIZE) throw new Error(`${name}: ${code.length} bytes exceeds the ${MAX_CODE_SIZE}-byte Stylus limit`);
      return { name, code };
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** EVM initcode that returns `code` as the contract's code (same prelude as cargo-stylus). */
function deploymentData(code: Uint8Array): Hex {
  const prelude: Hex = concat([
    '0x7f',
    numberToHex(code.length, { size: 32 }),
    '0x80', // DUP1
    '0x602b', // PUSH1 43 (prelude + version byte)
    '0x6000', // PUSH1 0
    '0x39', // CODECOPY
    '0x6000', // PUSH1 0
    '0xf3', // RETURN
    '0x00', // version
  ]);
  return concat([prelude, bytesToHex(code)]);
}

export async function deployProgram(wallet: WalletClient, client: PublicClient, code: Uint8Array): Promise<Address> {
  const account = wallet.account!;
  const hash = await wallet.sendTransaction({ account, chain: wallet.chain, data: deploymentData(code) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Stylus deployment failed');
  const address = receipt.contractAddress;
  let dataFee: bigint;
  try {
    const { result } = await client.simulateContract({
      account,
      address: ARB_WASM,
      abi: arbWasmAbi,
      functionName: 'activateProgram',
      args: [address],
      value: parseEther('1'),
    });
    dataFee = (result[1] * 120n) / 100n;
  } catch (err) {
    // Activation is per code hash: identical code deployed before is already active.
    if (err instanceof BaseError && err.message.includes('ProgramUpToDate')) return address;
    throw err;
  }
  const activation = await wallet.writeContract({ account, chain: wallet.chain, address: ARB_WASM, abi: arbWasmAbi, functionName: 'activateProgram', args: [address], value: dataFee });
  if ((await client.waitForTransactionReceipt({ hash: activation })).status !== 'success') throw new Error('Stylus activation failed');
  return address;
}

export interface Deployment {
  chainId: number;
  pool: Address;
  disputes: Address;
  verifier: Address;
  hasher: Address;
  usdg: Address;
  /** First block to scan for pool events. */
  deployBlock: string;
}

/**
 * Deploys and wires the four contracts. Initialization runs right after activation; if anyone
 * initialized a contract first, our call reverts and the deployment is abandoned.
 */
export async function deployOcculta(wallet: WalletClient, client: PublicClient, usdg: Address, { e2e = false } = {}): Promise<Deployment> {
  const built = Object.fromEntries(buildContracts({ e2e }).map((c) => [c.name, c.code])) as Record<ContractName, Uint8Array>;
  const deployBlock = await client.getBlockNumber();
  const verifier = await deployProgram(wallet, client, built.verifier);
  const hasher = await deployProgram(wallet, client, built.hasher);
  const pool = await deployProgram(wallet, client, built.pool);
  const disputes = await deployProgram(wallet, client, built.disputes);
  const account = wallet.account!;
  for (const hash of [
    await wallet.writeContract({ account, chain: wallet.chain, address: pool, abi: poolAbi, functionName: 'initialize', args: [usdg, verifier, hasher, disputes] }),
    await wallet.writeContract({ account, chain: wallet.chain, address: disputes, abi: disputesAbi, functionName: 'initialize', args: [pool, verifier] }),
  ]) {
    if ((await client.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error('initialization failed: someone else may have initialized first; redeploy');
  }
  return { chainId: await client.getChainId(), pool, disputes, verifier, hasher, usdg, deployBlock: deployBlock.toString() };
}
