// Local Arbitrum (Nitro) dev node with Stylus support, run straight from the official image's
// binary (no Docker needed, see scripts/setup-tools.sh). Used by `npm run devnode` and the tests.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEVNODE_DIR = join(REPO, '.devnode');
export const DEVNODE_RPC = 'http://127.0.0.1:8547';
/** Pre-funded account of the Nitro dev chain (public, dev-only). */
export const DEV_PRIVATE_KEY: Hex = '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659';

const NITRO = process.env.OCCULTA_NITRO ?? join(homedir(), '.local/share/occulta-tools/nitro-rootfs/usr/local/bin/nitro');
const PID_FILE = join(DEVNODE_DIR, 'nitro.pid');
const ARB_DEBUG = '0x00000000000000000000000000000000000000ff';
const ARB_OWNER = '0x0000000000000000000000000000000000000070';
const ARB_OWNER_PUBLIC = '0x000000000000000000000000000000000000006b';
const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c';

export const devChain = defineChain({
  id: 412346,
  name: 'Occulta dev node',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEVNODE_RPC] } },
});

export const devPublicClient = () => createPublicClient({ chain: devChain, transport: http(DEVNODE_RPC) });
export const devWalletClient = (key: Hex = DEV_PRIVATE_KEY) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: devChain, transport: http(DEVNODE_RPC) });

export async function isUp(): Promise<boolean> {
  try {
    await devPublicClient().getChainId();
    return true;
  } catch {
    return false;
  }
}

function pid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const value = Number(readFileSync(PID_FILE, 'utf8'));
  try {
    process.kill(value, 0);
    return value;
  } catch {
    return null;
  }
}

/** Starts the node in the background (idempotent) and prepares it like the official nitro-devnode script. */
export async function startDevnode(): Promise<void> {
  if (await isUp()) return prepareDevnode();
  if (!existsSync(NITRO)) throw new Error(`Nitro binary not found at ${NITRO} (run scripts/setup-tools.sh)`);
  mkdirSync(DEVNODE_DIR, { recursive: true });
  const log = openSync(join(DEVNODE_DIR, 'nitro.log'), 'a');
  const child = spawn(
    NITRO,
    [
      '--dev',
      '--http.addr', '127.0.0.1',
      '--http.port', '8547',
      '--http.api', 'net,web3,eth,debug',
      '--http.corsdomain', '*',
      '--http.vhosts', '*',
      '--persistent.global-config', join(DEVNODE_DIR, 'data'),
    ],
    { detached: true, stdio: ['ignore', log, log], env: { ...process.env, HOME: DEVNODE_DIR } },
  );
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 120 && !(await isUp()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await isUp())) throw new Error(`dev node did not start, see ${join(DEVNODE_DIR, 'nitro.log')}`);

  await prepareDevnode();
}

/** Makes the dev account chain owner and zeroes the L1 data price, as nitro-devnode does, so large
 * Stylus deployments are not limited by L1 pricing. Idempotent. */
async function prepareDevnode(): Promise<void> {
  const wallet = devWalletClient();
  const client = devPublicClient();
  const abi = parseAbi([
    'function isChainOwner(address) view returns (bool)',
    'function becomeChainOwner()',
    'function setL1PricePerUnit(uint256)',
    'function getL1BaseFeeEstimate() view returns (uint256)',
  ]);
  const owner = await client.readContract({ address: ARB_OWNER_PUBLIC, abi, functionName: 'isChainOwner', args: [wallet.account.address] });
  if (!owner) {
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: ARB_DEBUG, abi, functionName: 'becomeChainOwner' }) });
  }
  const l1Price = await client.readContract({ address: ARB_GAS_INFO, abi, functionName: 'getL1BaseFeeEstimate' });
  if (l1Price !== 0n) {
    await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: ARB_OWNER, abi, functionName: 'setL1PricePerUnit', args: [0n] }) });
  }
}

export async function stopDevnode(): Promise<void> {
  const running = pid();
  if (running) {
    process.kill(running, 'SIGTERM');
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(running, 0);
        await new Promise((r) => setTimeout(r, 250));
      } catch {
        break;
      }
    }
  }
  rmSync(PID_FILE, { force: true });
}

/** Stops the node and deletes its chain data and deployment, for a clean chain. */
export async function resetDevnode(): Promise<void> {
  await stopDevnode();
  rmSync(DEVNODE_DIR, { recursive: true, force: true });
}
