// The desktop client as a user runs it: real processes, its data folder, the local RPC server, and
// its relayer and libp2p relay roles serving a website-style user, against the dev node.
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { formatEther, parseEther } from 'viem';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { ChannelRepository } from '../../packages/framework/src/modules/channel/index.ts';
import { shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import { encodeInvite } from '../../packages/framework/src/modules/p2p/index.ts';
import { HttpRelayer } from '../../packages/framework/src/modules/relayer/index.ts';
import { MemoryStore } from '../../packages/framework/src/modules/storage/index.ts';
import { WalletRepository, WalletService } from '../../packages/framework/src/modules/wallet/index.ts';
import { devChain } from '../../scripts/lib/devnode.ts';
import { desktopRpc, freePort, runDesktop as run, startDesktop as startNode, stopDesktop as stop } from '../../scripts/lib/desktop-process.ts';
import { client, dev, freshDeployment } from './chain.ts';
import { devNetwork, newChannelNode, newUser, type ChannelNode } from './services.ts';

const ETH = 0n;

describe('desktop client on the dev node', () => {
  const phrase = generateMnemonic(wordlist, 128);
  const env = { OCCULTA_PASSWORD: 'password123', OCCULTA_SECRET: phrase };
  let network: NetworkConfig;
  let chain: ChainAdapter;
  let tmp: string;
  let dataDir: string;
  let tokenFile: string;
  let base: string[];
  let firstAccount: string;
  let relayerAccount: string;
  let token = '';
  let rpcUrl = '';
  const children: ChildProcess[] = [];
  const nodes: ChannelNode[] = [];

  const rpc = <T>(command: string, body: object = {}): Promise<T> => desktopRpc<T>({ url: rpcUrl, token }, command, body);

  beforeAll(async () => {
    const deployment = await freshDeployment();
    network = devNetwork(deployment);
    chain = new ChainAdapter(network);
    tmp = await mkdtemp(join(tmpdir(), 'occulta-desktop-'));
    dataDir = join(tmp, 'data');
    tokenFile = join(tmp, 'rpc.json');
    const networkFile = join(tmp, 'devnode.json');
    await writeFile(networkFile, JSON.stringify({ ...network, contracts: { ...network.contracts, deployBlock: String(deployment.deployBlock) } }));
    base = ['start', '--data-dir', dataDir, '--network-file', networkFile, '--network', network.id, '--no-shell', '--tick', '3600', '--rpc', '--rpc-token-file', tokenFile];
  });

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await Promise.all(nodes.map((n) => n.p2p.stop()));
    await rm(tmp, { recursive: true, force: true });
  });

  it('init creates a data folder that holds only the encrypted wallet, in the export file format', async () => {
    const created = await run(['init', '--phrase', '--data-dir', dataDir], env);
    expect(created.code).toBe(0);
    firstAccount = (JSON.parse(created.stdout) as { accounts: { id: string }[] }).accounts[0]!.id;
    expect(await readdir(dataDir)).toEqual(['occulta.wallet.json']);
    const content = await readFile(join(dataDir, 'occulta.wallet.json'), 'utf8');
    expect(JSON.parse(content)).toMatchObject({ format: 'occulta-wallet', version: 1 });
    expect(content).not.toContain(phrase.split(' ').slice(0, 2).join(' '));
    expect(content.toLowerCase()).not.toContain(firstAccount.slice(2).toLowerCase());

    const again = await run(['init', '--phrase', '--data-dir', dataDir], env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('ALREADY_INITIALIZED');
    const wrong = await run([...base, '--rpc-port', String(await freePort())], { ...env, OCCULTA_PASSWORD: 'wrong password' });
    expect(wrong.code).toBe(1);
  });

  it('serves the local RPC API only with its access token, and removes the token when it stops', async () => {
    const node = await startNode([...base, '--rpc-port', String(await freePort())], env);
    children.push(node.child);
    ({ url: rpcUrl, token } = JSON.parse(await readFile(tokenFile, 'utf8')) as { url: string; token: string });
    expect(rpcUrl).toBe(node.ready.rpc?.url);
    expect((await fetch(`${rpcUrl}/rpc/status`, { method: 'POST' })).status).toBe(401);
    const status = await rpc<{ account: { id: string }; network: { id: string } }>('status');
    expect(status).toMatchObject({ account: { id: firstAccount }, network: { id: network.id } });
    relayerAccount = (await rpc<{ id: string }>('account.add')).id;
    expect(await stop(node.child)).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('relays for others, is their libp2p relay, and runs a channel with a website-style user', async () => {
    for (const to of [firstAccount, relayerAccount]) {
      await client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ account: dev.account!, chain: devChain, to: to as `0x${string}`, value: parseEther('1') }) });
    }
    const [relayerPort, relayPort] = [await freePort(), await freePort()];
    const node = await startNode(
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
        String(relayerPort),
        '--libp2p-relay',
        '--libp2p-relay-host',
        '127.0.0.1',
        '--libp2p-relay-port',
        String(relayPort),
      ],
      env,
    );
    children.push(node.child);
    const previousToken = token;
    ({ url: rpcUrl, token } = JSON.parse(await readFile(tokenFile, 'utf8')) as { url: string; token: string });
    // A new access token at every start, and never in the data folder.
    expect(token).not.toBe(previousToken);
    expect(await readdir(dataDir)).toEqual(['occulta.wallet.json']);
    expect(await readFile(join(dataDir, 'occulta.wallet.json'), 'utf8')).not.toContain(token);
    expect(node.ready.relayer).toBe(`http://127.0.0.1:${relayerPort}`);
    const relayAddr = node.ready.libp2pRelay?.[0] as string;
    expect(relayAddr).toMatch(new RegExp(`^/ip4/127.0.0.1/tcp/${relayPort}/ws/p2p/`));

    // The node deposits from its own account and is paid privately through its own relayer.
    await rpc('deposit', { token: 'eth', amount: '0.2' });
    const web = await newUser(network, chain, '1');
    await web.pool.deposit(ETH, parseEther('0.1'));
    const viaDesktop = new HttpRelayer(node.ready.relayer as string);
    await web.pool.transfer(await rpc<string>('address'), ETH, parseEther('0.01'), viaDesktop);
    expect(await rpc('balance')).toMatchObject({ eth: '0.21 ETH' });

    // A channel with the website-style user, who reaches the desktop through its libp2p relay.
    const webNode = await newChannelNode(web, chain, relayAddr);
    nodes.push(webNode);
    const invite = encodeInvite(webNode.p2p.invite(shieldedAddressOf(await web.keys.poolKeys())));
    const opened = await rpc<{ id: string; status: string }>('channel.open', { invite, token: 'eth', amount: '0.05' });
    expect(opened.status).toBe('funding');
    expect(await webNode.channels.tick(viaDesktop)).toEqual([]);
    expect(await rpc('tick')).toEqual([]);
    expect((await rpc<{ status: string }[]>('channels'))[0]?.status).toBe('live');
    await rpc('channel.pay', { channel: opened.id, amount: '0.01' });
    await webNode.channels.pay(opened.id, parseEther('0.002')); // countersigned by the desktop on its own
    expect((await rpc<object[]>('channels'))[0]).toMatchObject({ balance: '0.0419 ETH', peerBalance: '0.008 ETH', closingFee: '0.0001 ETH' });
    const webBefore = web.pool.balances().get(ETH) ?? 0n;
    expect(await rpc('channel.close', { channel: opened.id })).toMatchObject({ status: 'closed' });
    expect(await webNode.channels.tick(viaDesktop)).toEqual([]);
    expect(web.pool.balances().get(ETH)).toBe(webBefore + parseEther('0.008'));

    // The relayer account earns fee notes and never deposits; no account sends public funds from here.
    await rpc('account.use', { account: relayerAccount });
    await expect(rpc('deposit', { token: 'eth', amount: '0.01' })).rejects.toMatchObject({ code: 'RELAYER_ACCOUNT' });
    await expect(rpc('public.send', { token: 'eth', to: firstAccount, amount: '0.01' })).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND' });
    const earned = await rpc<{ eth: string }>('balance');
    expect(Number.parseFloat(earned.eth)).toBeGreaterThan(0);
    await rpc('account.use', { account: firstAccount });

    // Its export file restores the same accounts and channels in the website's wallet core.
    const exportPath = join(tmp, 'export.json');
    await rpc('export', { path: exportPath });
    const website = new WalletService(new WalletRepository(new MemoryStore()));
    await website.importFile(await readFile(exportPath, 'utf8'), 'password123');
    expect(website.accounts().map((a) => a.id)).toEqual([firstAccount, relayerAccount]);
    expect(website.networkId()).toBe(network.id);
    expect(new ChannelRepository(website).all().map((c) => [c.id, c.status])).toEqual([[opened.id, 'closed']]);

    // And the other way round: the website's export file starts a desktop client with its accounts, notes and channels.
    const webExport = join(tmp, 'web-export.json');
    await writeFile(webExport, await web.wallet.exportFile());
    const [webData, webTokenFile] = [join(tmp, 'web-data'), join(tmp, 'web-rpc.json')];
    expect((await run(['init', '--import-file', webExport, '--data-dir', webData], env)).code).toBe(0);
    const fromWebsite = await startNode(
      [...base.map((a) => (a === dataDir ? webData : a === tokenFile ? webTokenFile : a)), '--rpc-port', String(await freePort()), '--libp2p-relays', relayAddr, '--relayers', node.ready.relayer as string],
      env,
    );
    children.push(fromWebsite.child);
    const asWebsite = JSON.parse(await readFile(webTokenFile, 'utf8')) as { url: string; token: string };
    const webRpc = <T>(command: string) => desktopRpc<T>(asWebsite, command, {});
    expect((await webRpc<{ id: string }[]>('accounts')).map((a) => a.id)).toEqual(web.wallet.accounts().map((a) => a.id));
    expect(await webRpc('balance')).toMatchObject({ eth: `${formatEther(web.pool.balances().get(ETH) ?? 0n)} ETH` });
    expect((await webRpc<{ id: string; status: string }[]>('channels')).map((c) => [c.id, c.status])).toEqual([[opened.id, 'closed']]);
    expect(await stop(fromWebsite.child)).toBe(0);
    expect(await stop(node.child)).toBe(0);
  });
});
