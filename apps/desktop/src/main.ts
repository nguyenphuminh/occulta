#!/usr/bin/env node
// Entry point of the desktop client (BRD 2.2.15): `init` creates the encrypted data folder, `start`
// runs the node with its shell, the local RPC server and the optional relayer and libp2p relay roles.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Libp2p } from '@libp2p/interface';
import { concat, hexToBytes, keccak256, stringToHex, zeroAddress } from 'viem';
import {
  AppError,
  BUILT_IN_NETWORKS,
  ChainAdapter,
  DirectRelayer,
  HttpRelayer,
  NetworkConfigSchema,
  Occulta,
  RelayerService,
  fileArtifacts,
  type NetworkConfig,
} from '@occulta/framework';
import { createPeerNode, createRelayNode } from '@occulta/framework/libp2p-node';
import { createRelayerApp, createRpcApp } from './app.ts';
import { USAGE, loadConfig, type Config } from './config/index.ts';
import { NodeService } from './modules/node/index.ts';
import { ShellService, formatError } from './modules/shell/index.ts';
import { FileStore } from './shared/integrations/file.store.ts';
import { createLogger, type Logger } from './shared/logger.ts';
import { parseAmount } from './shared/utils/amounts.ts';
import { readSecret } from './shared/utils/prompt.ts';

const ARTIFACTS = fileURLToPath(new URL('../../../packages/framework/artifacts', import.meta.url));

async function main(argv: string[]): Promise<void> {
  const config = loadConfig(argv);
  if (config.command === 'help') {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const logger = createLogger(config.logLevel);
  const networks: NetworkConfig[] = [...BUILT_IN_NETWORKS];
  if (config.networkFile) networks.push(NetworkConfigSchema.parse(JSON.parse(await readFile(config.networkFile, 'utf8'))));
  const occulta = new Occulta({
    store: new FileStore(config.dataDir),
    artifacts: fileArtifacts(ARTIFACTS),
    createNode: createPeerNode,
    networks,
    libp2pRelays: config.libp2pRelays,
    relayers: config.relayers?.map((url) => new HttpRelayer(url)),
    maxFee: maxFeesOf(config, networks),
  });
  if (config.command === 'init') return init(config, occulta);
  return start(config, occulta, logger);
}

function maxFeesOf(config: Config, networks: NetworkConfig[]): Map<bigint, bigint> | undefined {
  const { eth, usdg } = config.maxFee;
  if (!eth && !usdg) return undefined;
  const fees = new Map<bigint, bigint>();
  if (eth) fees.set(0n, parseAmount('eth', eth));
  if (usdg) for (const n of networks) fees.set(BigInt(n.usdg), parseAmount('usdg', usdg));
  return fees;
}

async function init(config: Config, occulta: Occulta): Promise<void> {
  const { wallet } = occulta;
  if (await wallet.exists()) throw new AppError(409, 'ALREADY_INITIALIZED', `A wallet already exists in ${config.dataDir}`);
  if (config.init.source === 'import-file') {
    await wallet.importFile(await readFile(config.init.importFile as string, 'utf8'), await readSecret('OCCULTA_PASSWORD', 'Password of the export file: '));
  } else {
    const secret = await readSecret('OCCULTA_SECRET', config.init.source === 'phrase' ? 'Recovery phrase: ' : 'Private key: ');
    const password = await readSecret('OCCULTA_PASSWORD', 'New data password (8+ characters): ');
    if (!process.env.OCCULTA_PASSWORD && (await readSecret('OCCULTA_PASSWORD', 'Repeat the password: ')) !== password) {
      throw new AppError(400, 'PASSWORD_MISMATCH', 'The passwords do not match');
    }
    if (config.init.source === 'phrase') await wallet.createFromPhrase(secret, password);
    else await wallet.importPrivateKey(secret, password);
  }
  stdout.write(`${JSON.stringify({ dataDir: config.dataDir, accounts: wallet.accounts().map((a) => ({ id: a.id, label: a.label })) }, null, 2)}\n`);
  wallet.lock();
}

async function start(config: Config, occulta: Occulta, logger: Logger): Promise<void> {
  const { wallet, keys } = occulta;
  await wallet.unlock(await readSecret('OCCULTA_PASSWORD', 'Data password: '));
  if (config.network) await wallet.setNetwork(config.network);
  const network = occulta.network();

  let relayerAccountId: string | undefined;
  let relayer: RelayerService | null = null;
  if (config.relayer.enabled) {
    const account = wallet.accounts().find((a) => a.id.toLowerCase() === (config.relayer.account as string).toLowerCase());
    if (!account) throw new AppError(404, 'UNKNOWN_ACCOUNT', `No account ${config.relayer.account} in this wallet`);
    if (account.id === wallet.activeAccount().id) throw new AppError(409, 'RELAYER_ACCOUNT', 'The relayer account cannot be the active account');
    if (account.used) throw new AppError(409, 'RELAYER_ACCOUNT', 'This account has made deposits or public sends; choose an unused account for relaying');
    relayerAccountId = account.id;
    relayer = new RelayerService(new ChainAdapter(network), {
      account: wallet.signer(account.id),
      keys: await keys.poolKeys(account.id),
      fees: { [zeroAddress]: parseAmount('eth', config.relayer.feeEth as string), [network.usdg]: parseAmount('usdg', config.relayer.feeUsdg as string) },
    });
    // Without a relayer list, a node that relays submits its own transactions too.
    if (!config.relayers) occulta.configure({ relayers: [new DirectRelayer(relayer)] });
  }

  let relayNode: Libp2p | null = null;
  if (config.libp2pRelay.enabled) {
    // A stable relay identity, derived from the wallet's first account and unrelated to its channel identity.
    const first = wallet.accounts()[0]?.id as string;
    const seed = hexToBytes(keccak256(concat([(await keys.poolKeys(first)).seed, stringToHex('libp2p-relay')])));
    relayNode = await createRelayNode({ listen: [`/ip4/${config.libp2pRelay.host}/tcp/${config.libp2pRelay.port}/ws`], announce: config.libp2pRelay.announce, seed });
    // Without a relay list, a node that is a libp2p relay reaches its own peers through itself, over
    // its local address: an announced public name may not resolve yet, and would loop out and back in.
    // Its invites still carry the announced address, which the relay gives with the reservation.
    const local = config.libp2pRelay.host === '0.0.0.0' ? '127.0.0.1' : config.libp2pRelay.host;
    const own = `/ip4/${local}/tcp/${config.libp2pRelay.port}/ws/p2p/${relayNode.peerId.toString()}`;
    if (!config.libp2pRelays) occulta.configure({ libp2pRelays: [own] });
  }

  await occulta.start();
  const relayerUrl = relayer ? `http://${config.relayer.host}:${config.relayer.port}` : null;
  const libp2pRelay = () => relayNode?.getMultiaddrs().map(String) ?? null;
  const node = new NodeService(occulta, { relayerAccountId, roles: () => ({ relayer: relayerUrl && { url: relayerUrl, account: relayerAccountId }, libp2pRelay: libp2pRelay() }) });

  let ready = false;
  const servers: Server[] = [];
  let rpc: { url: string; tokenFile: string } | null = null;
  if (config.rpc.enabled) {
    const token = randomBytes(32).toString('hex');
    servers.push(await listen(createRpcApp({ node, token, logger, ready: () => ready }), config.rpc.port, '127.0.0.1'));
    rpc = { url: `http://127.0.0.1:${config.rpc.port}`, tokenFile: config.rpc.tokenFile };
    await mkdir(dirname(config.rpc.tokenFile), { recursive: true, mode: 0o700 });
    await writeFile(config.rpc.tokenFile, JSON.stringify({ url: rpc.url, token }), { mode: 0o600 });
  }
  if (relayer) servers.push(await listen(createRelayerApp({ relayer, logger }), config.relayer.port, config.relayer.host));

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    occulta
      .tick()
      .then((problems) => problems.forEach((p) => logger.warn({ module: 'node', channel: p.channelId, err: p.error }, 'channel needs attention')))
      .catch((err: unknown) => logger.warn({ module: 'node', err }, 'background sync failed'))
      .finally(() => {
        ticking = false;
      });
  }, config.tickSeconds * 1000);

  let stopping: Promise<void> | null = null;
  const shutdown = () =>
    (stopping ??= (async () => {
      ready = false;
      clearInterval(timer);
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      await relayNode?.stop();
      await occulta.lock();
      if (rpc) await rm(rpc.tokenFile, { force: true });
      logger.info({ module: 'node' }, 'stopped');
    })());
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  ready = true;
  const summary = { account: wallet.activeAccount().id, network: network.id, rpc, relayer: relayerUrl, libp2pRelay: libp2pRelay() };
  stdout.write(`occulta ready ${JSON.stringify(summary)}\n`);
  logger.info({ module: 'node', ...summary }, 'started');
  if (config.shell && stdin.isTTY) {
    await new ShellService(node).run(stdin, stdout);
    await shutdown();
    process.exit(0);
  }
}

function listen(app: ReturnType<typeof createRpcApp>, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${formatError(err)}\n`);
  process.exitCode = 1;
});
