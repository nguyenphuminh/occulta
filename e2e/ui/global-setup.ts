// Starts everything the website needs for UI tests: the dev node with fresh contracts, the desktop
// client as transaction relayer and libp2p relay, and a production build of the website that
// knows the dev network. Returns the teardown.
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { parseEther } from 'viem';
import { build, preview } from 'vite';
import { REPO, devChain, startDevnode } from '../../scripts/lib/devnode.ts';
import { buildContracts } from '../../scripts/lib/stylus.ts';
import { client, dev, freshDeployment } from '../integration/chain.ts';
import { devNetwork } from '../integration/services.ts';
import { desktopRpc, freePort, runDesktop, startDesktop, stopDesktop } from '../../scripts/lib/desktop-process.ts';

export const UI_PORT = 5199;

export default async function setup(): Promise<() => Promise<void>> {
  await startDevnode();
  buildContracts({ e2e: true });
  const deployment = await freshDeployment();
  const network = devNetwork(deployment);
  const tmp = await mkdtemp(join(tmpdir(), 'occulta-ui-'));
  const networkFile = join(tmp, 'devnode.json');
  await writeFile(networkFile, JSON.stringify({ ...network, contracts: { ...network.contracts, deployBlock: String(deployment.deployBlock) } }));

  // The desktop client: one account of its own, one never-used account for relaying.
  const env = { OCCULTA_PASSWORD: 'password123', OCCULTA_SECRET: generateMnemonic(wordlist, 128) };
  const dataDir = join(tmp, 'desktop');
  const tokenFile = join(tmp, 'rpc.json');
  const base = ['start', '--data-dir', dataDir, '--network-file', networkFile, '--network', network.id, '--no-shell', '--rpc', '--rpc-token-file', tokenFile, '--log-level', 'warn'];
  if ((await runDesktop(['init', '--phrase', '--data-dir', dataDir], env)).code !== 0) throw new Error('desktop init failed');
  const first = await startDesktop([...base, '--rpc-port', String(await freePort())], env);
  const relayerAccount = (await desktopRpc<{ id: string }>(JSON.parse(await readFile(tokenFile, 'utf8')) as { url: string; token: string }, 'account.add')).id;
  await stopDesktop(first.child);
  await client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ account: dev.account!, chain: devChain, to: relayerAccount as `0x${string}`, value: parseEther('10') }) });
  const desktop: { child: ChildProcess; ready: { relayer: string | null; libp2pRelay: string[] | null } } = await startDesktop(
    [
      ...base,
      '--rpc-port',
      String(await freePort()),
      '--relayer',
      '--relayer-account',
      relayerAccount,
      '--relayer-fee-eth',
      '0.0001',
      '--relayer-fee-usdg',
      '0.01',
      '--relayer-host',
      '127.0.0.1',
      '--relayer-port',
      String(await freePort()),
      '--libp2p-relay',
      '--libp2p-relay-host',
      '127.0.0.1',
      '--libp2p-relay-port',
      String(await freePort()),
    ],
    env,
  );

  // The website, built with the dev network (its relayer and relay are the desktop client's).
  const webNetwork = { ...network, contracts: { ...network.contracts, deployBlock: String(deployment.deployBlock) }, relayers: [desktop.ready.relayer], libp2pRelays: desktop.ready.libp2pRelay };
  process.env.VITE_OCCULTA_DEV_NETWORK = JSON.stringify(webNetwork);
  process.env.VITE_OCCULTA_TICK_MS = '1500';
  const root = join(REPO, 'apps/web');
  // OCCULTA_UI_PROFILE keeps function names readable in CPU profiles.
  await build({ root, logLevel: 'warn', build: { outDir: join(tmp, 'web'), minify: process.env.OCCULTA_UI_PROFILE ? false : undefined } });
  const server = await preview({ root, logLevel: 'warn', build: { outDir: join(tmp, 'web') }, preview: { host: '127.0.0.1', port: UI_PORT, strictPort: true } });
  process.env.OCCULTA_UI_NETWORK = JSON.stringify(webNetwork);

  return async () => {
    await new Promise((resolve) => server.httpServer.close(resolve));
    await stopDesktop(desktop.child);
    await rm(tmp, { recursive: true, force: true });
  };
}
