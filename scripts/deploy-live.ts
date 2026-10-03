// npm run deploy:live [-- --project <gcp-project-id>]
// The live deployment, in one command that is safe to run again:
//   - the website on Cloudflare at https://occulta.space (Workers static assets, apps/web/wrangler.jsonc);
//   - one Google Cloud VM at relay.occulta.space running the desktop client as transaction relayer
//     and libp2p relay for Arbitrum Sepolia, behind Caddy (automatic HTTPS; WebSockets go to the relay).
// It deploys the current commit, so the git tree must be clean.
//
// Needs a signed-in gcloud (gcloud auth login) and Cloudflare: either the browser sign-ins
// `npx wrangler login` and `~/.local/bin/cloudflared tunnel login` (choose occulta.space), or an API
// token for occulta.space in ~/.occulta-secrets/cloudflare.token.
// ~/.occulta-secrets/funder.key, a funded Arbitrum Sepolia key, tops up the relayer's gas when set.
// The relay's wallet is made on the first run and kept in .occulta/live (git-ignored, mode 600).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPeerNode } from '../packages/framework/src/libp2p.node.ts';
import { BUILT_IN_NETWORKS } from '../packages/framework/src/modules/chain/index.ts';
import { P2PService } from '../packages/framework/src/modules/p2p/index.ts';
import { desktopRpc, freePort, runDesktop, startDesktop, stopDesktop } from './lib/desktop-process.ts';
import { REPO } from './lib/devnode.ts';

const DOMAIN = 'occulta.space';
const RELAY_HOST = `relay.${DOMAIN}`;
const RELAYER_URL = `https://${RELAY_HOST}`;
const NETWORK_ID = 'arbitrum-sepolia';
const VM = { name: 'occulta-relay', region: 'us-central1', zone: 'us-central1-a', machine: 'e2-small', tag: 'occulta-relay' };
const SECRETS = join(homedir(), '.occulta-secrets');
const STATE = join(REPO, '.occulta/live');
const GCLOUD = process.env.GCLOUD ?? join(homedir(), '.local/opt/google-cloud-sdk/bin/gcloud');
/** The relayer pays gas for every relayed transaction; below this it is topped up. */
const RELAYER_MIN = parseEther('0.01');
const RELAYER_TOP_UP = parseEther('0.02');

interface RelayWallet {
  password: string;
  phrase: string;
  relayerAccount: Address;
  relayPeerId: string;
}

const network = BUILT_IN_NETWORKS.find((n) => n.id === NETWORK_ID);
if (!network) throw new Error(`no built-in network ${NETWORK_ID}`);
const relayAddress = (peerId: string) => `/dns4/${RELAY_HOST}/tcp/443/wss/p2p/${peerId}`;

function step(text: string): void {
  console.log(`\n▸ ${text}`);
}

function run(cmd: string, args: string[], options: { env?: Record<string, string>; quiet?: boolean; cwd?: string } = {}): string {
  return execFileSync(cmd, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function secret(name: string): string | null {
  const file = join(SECRETS, name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

// --- the relay's wallet: its own account plus a never-used account that submits relayed transactions ---

async function relayWallet(): Promise<RelayWallet> {
  const file = join(STATE, 'wallet.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as RelayWallet;
  step('creating the relay’s wallet (once)');
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const env = { OCCULTA_PASSWORD: randomBytes(24).toString('hex'), OCCULTA_SECRET: generateMnemonic(wordlist, 128) };
  const dataDir = join(STATE, 'node');
  const init = await runDesktop(['init', '--phrase', '--data-dir', dataDir], env);
  if (init.code !== 0) throw new Error(init.stderr);
  const tokenFile = join(STATE, 'rpc.json');
  const node = await startDesktop(
    ['start', '--data-dir', dataDir, '--network', NETWORK_ID, '--no-shell', '--log-level', 'warn', '--rpc', '--rpc-port', String(await freePort()), '--rpc-token-file', tokenFile, '--libp2p-relay', '--libp2p-relay-host', '127.0.0.1', '--libp2p-relay-port', String(await freePort())],
    env,
  );
  try {
    const relayerAccount = (await desktopRpc<{ id: Address }>(JSON.parse(readFileSync(tokenFile, 'utf8')) as { url: string; token: string }, 'account.add')).id;
    const relayPeerId = (node.ready.libp2pRelay?.[0] ?? '').split('/p2p/')[1] as string;
    const wallet: RelayWallet = { password: env.OCCULTA_PASSWORD, phrase: env.OCCULTA_SECRET, relayerAccount, relayPeerId };
    writeFileSync(file, JSON.stringify(wallet, null, 2), { mode: 0o600 });
    return wallet;
  } finally {
    await stopDesktop(node.child);
  }
}

/** The built-in network has to list the live relayer and relay, so the website and desktop clients use them. */
function checkNetworkConfig(wallet: RelayWallet): void {
  const relay = relayAddress(wallet.relayPeerId);
  if (network?.relayers.includes(RELAYER_URL) && network.libp2pRelays.includes(relay)) return;
  throw new Error(
    `The ${NETWORK_ID} entry in packages/framework/src/modules/chain/chain.config.ts must list the live relays:\n` +
      `    relayers: ['${RELAYER_URL}'],\n    libp2pRelays: ['${relay}'],\nUpdate it, commit, and run this again.`,
  );
}

async function fundRelayer(wallet: RelayWallet): Promise<void> {
  const chain = defineChain({ id: network!.chainId, name: network!.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [network!.rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(network!.rpcUrl) });
  const balance = await client.getBalance({ address: wallet.relayerAccount });
  console.log(`  relayer account ${wallet.relayerAccount}: ${formatEther(balance)} ETH`);
  if (balance >= RELAYER_MIN) return;
  const key = secret('funder.key');
  if (!key) {
    console.log(`  ⚠ send some ${network!.name} ETH to ${wallet.relayerAccount}: it pays the gas of relayed transactions`);
    return;
  }
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  const hash = await createWalletClient({ account, chain, transport: http(network!.rpcUrl) }).sendTransaction({ to: wallet.relayerAccount, value: RELAYER_TOP_UP });
  await client.waitForTransactionReceipt({ hash });
  console.log(`  topped up with ${formatEther(RELAYER_TOP_UP)} ETH from ${account.address} (${hash})`);
}

// --- Cloudflare ---

interface CloudflareAuth {
  /** For the DNS API: the token file, or the zone token in cloudflared's login certificate. */
  apiToken: string;
  /** For wrangler: the token file, or nothing (wrangler's own browser login). */
  wranglerEnv: Record<string, string>;
}

function cloudflareAuth(): CloudflareAuth {
  const token = secret('cloudflare.token');
  if (token) return { apiToken: token, wranglerEnv: { CLOUDFLARE_API_TOKEN: token } };
  const pem = join(homedir(), '.cloudflared/cert.pem');
  const body = existsSync(pem) ? readFileSync(pem, 'utf8').match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]+?)-----END ARGO TUNNEL TOKEN-----/)?.[1] : undefined;
  if (!body) throw new Error(`sign in to Cloudflare: npx wrangler login, then ~/.local/bin/cloudflared tunnel login (choose ${DOMAIN}); or put an API token in ${join(SECRETS, 'cloudflare.token')}`);
  return { apiToken: (JSON.parse(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')) as { apiToken: string }).apiToken, wranglerEnv: {} };
}

async function cloudflare<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  const body = (await res.json()) as { success: boolean; result: T; errors: { message: string }[] };
  if (!body.success) throw new Error(`Cloudflare ${path}: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.result;
}

async function deployWebsite(auth: CloudflareAuth): Promise<void> {
  step(`building the website and deploying it to https://${DOMAIN}`);
  const [zone] = await cloudflare<{ id: string; account: { id: string } }[]>(auth.apiToken, `/zones?name=${DOMAIN}`);
  if (!zone) throw new Error(`the Cloudflare sign-in cannot see the zone ${DOMAIN}`);
  run('npm', ['run', 'build', '-w', 'apps/web'], { quiet: true });
  run('npx', ['wrangler', 'deploy', '--config', 'apps/web/wrangler.jsonc'], { env: { ...auth.wranglerEnv, CLOUDFLARE_ACCOUNT_ID: zone.account.id } });
}

/** relay.occulta.space points straight at the VM (not proxied), so Caddy gets its own certificate. */
async function pointRelayName(token: string, ip: string): Promise<void> {
  step(`pointing ${RELAY_HOST} at ${ip}`);
  const [zone] = await cloudflare<{ id: string }[]>(token, `/zones?name=${DOMAIN}`);
  const records = await cloudflare<{ id: string; content: string }[]>(token, `/zones/${zone!.id}/dns_records?type=A&name=${RELAY_HOST}`);
  const record = { type: 'A', name: RELAY_HOST, content: ip, ttl: 300, proxied: false, comment: 'Occulta relay (Google Cloud VM)' };
  if (records[0]?.content === ip) return;
  if (records[0]) await cloudflare(token, `/zones/${zone!.id}/dns_records/${records[0].id}`, { method: 'PUT', body: JSON.stringify(record) });
  else await cloudflare(token, `/zones/${zone!.id}/dns_records`, { method: 'POST', body: JSON.stringify(record) });
}

// --- Google Cloud ---

function gcloud(project: string, args: string[], quiet = true): string {
  return run(GCLOUD, [...args, `--project=${project}`, '--quiet'], { quiet });
}

function exists(project: string, args: string[]): boolean {
  try {
    gcloud(project, args);
    return true;
  } catch {
    return false;
  }
}

function projectId(given: string | undefined): string {
  if (given) return given;
  const configured = run(GCLOUD, ['config', 'get-value', 'project'], { quiet: true }).trim();
  if (configured) return configured;
  const projects = JSON.parse(run(GCLOUD, ['projects', 'list', '--format=json'], { quiet: true })) as { projectId: string }[];
  if (projects.length === 1) return projects[0]!.projectId;
  throw new Error(`choose the Google Cloud project: npm run deploy:live -- --project <id> (${projects.map((p) => p.projectId).join(', ')})`);
}

function ensureVm(project: string): string {
  step(`Google Cloud: ${VM.machine} VM "${VM.name}" in ${VM.zone} (project ${project})`);
  gcloud(project, ['services', 'enable', 'compute.googleapis.com']);
  if (!exists(project, ['compute', 'addresses', 'describe', VM.name, `--region=${VM.region}`])) {
    gcloud(project, ['compute', 'addresses', 'create', VM.name, `--region=${VM.region}`]);
  }
  const ip = gcloud(project, ['compute', 'addresses', 'describe', VM.name, `--region=${VM.region}`, '--format=value(address)']).trim();
  if (!exists(project, ['compute', 'firewall-rules', 'describe', `${VM.name}-web`])) {
    gcloud(project, ['compute', 'firewall-rules', 'create', `${VM.name}-web`, '--allow=tcp:80,tcp:443', `--target-tags=${VM.tag}`, '--description=Occulta relay: HTTPS, WebSockets, and HTTP for certificates']);
  }
  if (!exists(project, ['compute', 'instances', 'describe', VM.name, `--zone=${VM.zone}`])) {
    gcloud(project, [
      'compute',
      'instances',
      'create',
      VM.name,
      `--zone=${VM.zone}`,
      `--machine-type=${VM.machine}`,
      '--image-family=debian-12',
      '--image-project=debian-cloud',
      '--boot-disk-size=20GB',
      `--address=${ip}`,
      `--tags=${VM.tag}`,
    ]);
  }
  return ip;
}

async function installRelay(project: string, wallet: RelayWallet): Promise<void> {
  step('installing the relay on the VM');
  const dir = join(STATE, 'upload');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  run('git', ['archive', '--format=tar.gz', '-o', join(dir, 'release.tgz'), 'HEAD']);
  run('tar', ['-czf', join(dir, 'node-data.tgz'), '-C', STATE, 'node']);
  writeFileSync(join(dir, 'node.env'), `OCCULTA_PASSWORD=${wallet.password}\n`, { mode: 0o600 });
  chmodSync(join(dir, 'node.env'), 0o600);
  writeFileSync(join(dir, 'install-relay.sh'), readFileSync(join(REPO, 'scripts/live/install-relay.sh')));
  const target = `${VM.name}:/tmp/occulta-deploy`;
  // A new VM takes a moment before it accepts SSH.
  for (let attempt = 1; ; attempt++) {
    try {
      gcloud(project, ['compute', 'ssh', VM.name, `--zone=${VM.zone}`, '--command=rm -rf /tmp/occulta-deploy && mkdir -p /tmp/occulta-deploy']);
      break;
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  gcloud(project, ['compute', 'scp', `--zone=${VM.zone}`, join(dir, 'release.tgz'), join(dir, 'node-data.tgz'), join(dir, 'node.env'), join(dir, 'install-relay.sh'), target]);
  const nodeVersion = process.version;
  gcloud(project, ['compute', 'ssh', VM.name, `--zone=${VM.zone}`, `--command=sudo bash /tmp/occulta-deploy/install-relay.sh ${nodeVersion} ${RELAY_HOST} ${wallet.relayerAccount} ${NETWORK_ID}; rm -rf /tmp/occulta-deploy`], false);
}

// --- checks: the relayer answers over HTTPS, and a peer reserves a slot whose invite carries the public address ---

async function waitForRelay(wallet: RelayWallet): Promise<void> {
  step(`waiting for ${RELAYER_URL} (Caddy gets its certificate on the first request)`);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      const res = await fetch(`${RELAYER_URL}/relayer/info`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        console.log(`  relayer: ${JSON.stringify(await res.json())}`);
        break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${RELAYER_URL} did not answer in 10 minutes`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const relay = relayAddress(wallet.relayPeerId);
  const peer = new P2PService(await createPeerNode({ relays: [relay] }));
  try {
    await peer.waitForRelay(60_000);
    const addrs = peer.invite('check').addrs;
    if (!addrs.every((a) => a.startsWith(`${relay}/p2p-circuit/`))) throw new Error(`invite addresses are not public: ${addrs.join(', ')}`);
    console.log(`  libp2p relay: a peer reserved a slot; invites carry ${relay}`);
  } finally {
    await peer.stop();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { project: { type: 'string' } } });
  // Local and harmless, so first: the relay's identity decides the network configuration.
  const wallet = await relayWallet();
  checkNetworkConfig(wallet);
  if (run('git', ['status', '--porcelain'], { quiet: true }).trim()) throw new Error('commit your changes first: the live deployment ships the current commit');
  const project = projectId(values.project);
  await fundRelayer(wallet);
  const ip = ensureVm(project);
  await installRelay(project, wallet);
  const auth = cloudflareAuth();
  await pointRelayName(auth.apiToken, ip);
  // Caddy asks for its certificate as soon as the name points here, instead of at its next retry.
  gcloud(project, ['compute', 'ssh', VM.name, `--zone=${VM.zone}`, '--command=sudo systemctl restart caddy']);
  await waitForRelay(wallet);
  await deployWebsite(auth);
  console.log(`\nLive: https://${DOMAIN} · relayer ${RELAYER_URL} · relay ${relayAddress(wallet.relayPeerId)}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
