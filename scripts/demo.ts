// Try Occulta by hand, with everything running on this machine:
//   npm run demo                             a local chain with fresh contracts, the desktop client as
//                                            transaction relayer and libp2p relay, and the website
//   npm run demo -- --sepolia                the website and a local desktop relayer/relay on Arbitrum Sepolia
//   npm run demo -- fund <address> [eth] [usdg]   local chain only: test ETH and USDG for an address
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createPublicClient, formatEther, http, parseAbi, parseEther, parseUnits, type Address } from 'viem';
import { createServer } from 'vite';
import { BUILT_IN_NETWORKS, type NetworkConfig } from '../packages/framework/src/modules/chain/index.ts';
import { desktopRpc, runDesktop, startDesktop, stopDesktop } from './lib/desktop-process.ts';
import { DEVNODE_DIR, DEVNODE_RPC, REPO, devChain, devPublicClient, devWalletClient, startDevnode } from './lib/devnode.ts';
import { deployOcculta, type Deployment } from './lib/stylus.ts';
import { deployTestToken } from './lib/test-token.ts';

const PORTS = { rpc: 8645, relayer: 8646, relay: 8647, web: 5173 };
const PASSWORD = 'occulta-demo';
const sepolia = process.argv.includes('--sepolia');
const dir = sepolia ? join(homedir(), '.occulta-demo', 'sepolia') : join(DEVNODE_DIR, 'demo');
const stateFile = join(dir, 'demo.json');

interface State {
  deployment?: Deployment;
  relayerAccount?: Address;
}

const load = (): State => (existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as State) : {});
const save = (state: State) => writeFileSync(stateFile, JSON.stringify(state, null, 2));

function localNetwork(d: Deployment): NetworkConfig {
  return {
    id: 'devnode',
    name: 'Local dev chain',
    chainId: d.chainId,
    rpcUrl: DEVNODE_RPC,
    usdg: d.usdg,
    contracts: { pool: d.pool, disputes: d.disputes, deployBlock: BigInt(d.deployBlock) },
    relayers: [],
    libp2pRelays: [],
  };
}

const toJson = (n: NetworkConfig) => JSON.stringify({ ...n, contracts: n.contracts && { ...n.contracts, deployBlock: String(n.contracts.deployBlock) } });

async function fund(address: Address, eth: string, usdg: string): Promise<void> {
  const deployment = load().deployment;
  if (sepolia || !deployment) throw new Error('fund works on the local chain only; run `npm run demo` first');
  const wallet = devWalletClient();
  const client = devPublicClient();
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: wallet.account!, chain: devChain, to: address, value: parseEther(eth) }) });
  const mint = parseAbi(['function mint(address to, uint256 value)']);
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({ account: wallet.account!, chain: devChain, address: deployment.usdg, abi: mint, functionName: 'mint', args: [address, parseUnits(usdg, 6)] }),
  });
  console.log(`sent ${eth} ETH and ${usdg} test USDG to ${address}`);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'fund') return fund(process.argv[3] as Address, process.argv[4] ?? '1', process.argv[5] ?? '1000');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = load();
  let network: NetworkConfig;
  if (sepolia) {
    network = BUILT_IN_NETWORKS.find((n) => n.id === 'arbitrum-sepolia') as NetworkConfig;
  } else {
    await startDevnode();
    if (!state.deployment) {
      console.log('deploying fresh contracts to the local chain…');
      const usdg = await deployTestToken(devWalletClient(), devPublicClient());
      // The test build accepts dispute windows from 10 s, so disputes can be tried from the desktop client.
      state.deployment = await deployOcculta(devWalletClient(), devPublicClient(), usdg, { e2e: true });
      save(state);
    }
    network = localNetwork(state.deployment);
  }
  const networkFile = join(dir, 'network.json');
  writeFileSync(networkFile, toJson(network));

  // The desktop client: its own account plus a never-used account that submits relayed transactions.
  const env = { OCCULTA_PASSWORD: PASSWORD, OCCULTA_SECRET: generateMnemonic(wordlist, 128) };
  const dataDir = join(dir, 'desktop');
  const tokenFile = join(dir, 'rpc.json');
  const base = ['start', '--data-dir', dataDir, '--network-file', networkFile, '--network', network.id, '--no-shell', '--log-level', 'warn'];
  const rpcArgs = ['--rpc', '--rpc-port', String(PORTS.rpc), '--rpc-token-file', tokenFile];
  if (!existsSync(dataDir)) {
    const init = await runDesktop(['init', '--phrase', '--data-dir', dataDir], env);
    if (init.code !== 0) throw new Error(init.stderr);
  }
  if (!state.relayerAccount) {
    const first = await startDesktop([...base, ...rpcArgs], env);
    state.relayerAccount = (await desktopRpc<{ id: Address }>(JSON.parse(readFileSync(tokenFile, 'utf8')) as { url: string; token: string }, 'account.add')).id;
    await stopDesktop(first.child);
    save(state);
    if (!sepolia) await fund(state.relayerAccount, '10', '0');
  }
  const client = createPublicClient({ transport: http(network.rpcUrl) });
  const relayerBalance = await client.getBalance({ address: state.relayerAccount });
  const desktop = await startDesktop(
    [
      ...base,
      ...rpcArgs,
      '--relayer',
      '--relayer-account',
      state.relayerAccount,
      '--relayer-fee-eth',
      '0.0001',
      '--relayer-fee-usdg',
      '0.01',
      '--relayer-host',
      '127.0.0.1',
      '--relayer-port',
      String(PORTS.relayer),
      '--libp2p-relay',
      '--libp2p-relay-host',
      '127.0.0.1',
      '--libp2p-relay-port',
      String(PORTS.relay),
    ],
    env,
  );
  const relayer = desktop.ready.relayer as string;
  const relay = desktop.ready.libp2pRelay?.[0] as string;

  // The website, with the local chain (and its relayer and relay) built in, or plain on Sepolia.
  if (!sepolia) process.env.VITE_OCCULTA_DEV_NETWORK = toJson({ ...network, relayers: [relayer], libp2pRelays: [relay] });
  process.env.VITE_OCCULTA_TICK_MS = '3000';
  const web = await createServer({ root: join(REPO, 'apps/web'), logLevel: 'warn', server: { host: '127.0.0.1', port: PORTS.web, strictPort: true } });
  await web.listen();

  const lines = [
    '',
    `Occulta is running. Open http://127.0.0.1:${PORTS.web} (use a second browser profile or a private window as a second user).`,
    '',
    sepolia
      ? [
          'Network: Arbitrum Sepolia (the default for a new wallet). In Settings, add:',
          `  transaction relayer  ${relayer}`,
          `  libp2p relay         ${relay}`,
          `Fund your wallet's address with Sepolia ETH. The relayer account ${state.relayerAccount} pays the gas of`,
          `relayed transactions and holds ${formatEther(relayerBalance)} ETH${relayerBalance < parseEther('0.002') ? ' — send it about 0.01 ETH first' : ''}.`,
        ].join('\n')
      : [
          'In the wallet, pick the network "Local dev chain" (top right). Its relayer and relay are already set.',
          'Give a wallet test money:  npm run demo -- fund <address shown on the Public tab> [eth] [usdg]',
          'Disputes from the website use the 7-day window; the desktop client accepts windows from 10 s.',
        ].join('\n'),
    '',
    `Desktop client RPC: ${desktop.ready.rpc?.url} (token in ${tokenFile}). Its data folder password is "${PASSWORD}".`,
    'Press Ctrl+C to stop.',
  ];
  console.log(lines.join('\n'));
  process.once('SIGINT', () => {
    void Promise.all([stopDesktop(desktop.child), web.close()]).then(() => process.exit(0));
  });
}

await main();
