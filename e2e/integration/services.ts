// Builds framework services against a fresh dev-node deployment, as a host application would.
import { join } from 'node:path';
import { parseAbi, parseEther, zeroAddress, type Address } from 'viem';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createPeerNode } from '../../packages/framework/src/libp2p.node.ts';
import { ChainAdapter, type NetworkConfig } from '../../packages/framework/src/modules/chain/index.ts';
import { ChannelRepository, ChannelService, type ChannelDeps } from '../../packages/framework/src/modules/channel/index.ts';
import { DisputeService } from '../../packages/framework/src/modules/dispute/index.ts';
import { KeyRing } from '../../packages/framework/src/modules/keys/index.ts';
import { P2PService } from '../../packages/framework/src/modules/p2p/index.ts';
import { PoolRepository, PoolService } from '../../packages/framework/src/modules/pool/index.ts';
import { DirectRelayer, RelayerService } from '../../packages/framework/src/modules/relayer/index.ts';
import { MemoryStore } from '../../packages/framework/src/modules/storage/index.ts';
import { WalletRepository, WalletService } from '../../packages/framework/src/modules/wallet/index.ts';
import { Prover, fileArtifacts } from '../../packages/framework/src/shared/integrations/prover.ts';
import { DEVNODE_RPC, REPO, devChain } from '../../scripts/lib/devnode.ts';
import type { Deployment } from '../../scripts/lib/stylus.ts';
import { client, dev } from './chain.ts';

export const prover = new Prover(fileArtifacts(join(REPO, 'packages/framework/artifacts')));
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

export function devNetwork(d: Deployment): NetworkConfig {
  return {
    id: 'devnode',
    name: 'Dev node',
    chainId: d.chainId,
    rpcUrl: DEVNODE_RPC,
    usdg: d.usdg,
    contracts: { pool: d.pool, disputes: d.disputes, deployBlock: BigInt(d.deployBlock) },
    relayers: [],
    libp2pRelays: [],
  };
}

export interface User {
  wallet: WalletService;
  keys: KeyRing;
  pool: PoolService;
  address: Address;
}

/** A user with a fresh wallet on the dev network, funded with ETH (and optionally test USDG). */
export async function newUser(network: NetworkConfig, chain: ChainAdapter, eth = '1', usdg = 0n): Promise<User> {
  const wallet = new WalletService(new WalletRepository(new MemoryStore()), FAST_KDF);
  const account = await wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
  await wallet.setNetwork(network.id);
  const keys = new KeyRing(wallet);
  const pool = new PoolService({ wallet, keys, chain, prover, repository: new PoolRepository(wallet) });
  await client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ account: dev.account!, chain: devChain, to: account.address, value: parseEther(eth) }) });
  if (usdg > 0n) {
    const mint = parseAbi(['function mint(address to, uint256 value)']);
    await client.waitForTransactionReceipt({
      hash: await dev.writeContract({ account: dev.account!, chain: devChain, address: network.usdg, abi: mint, functionName: 'mint', args: [account.address, usdg] }),
    });
  }
  return { wallet, keys, pool, address: account.address };
}

/** A relayer run by its own (desktop) user, charging the given fees. */
export async function newRelayer(network: NetworkConfig, chain: ChainAdapter, fees: { eth: bigint; usdg: bigint }) {
  const user = await newUser(network, chain, '5');
  const service = new RelayerService(chain, {
    account: user.wallet.signer(),
    keys: await user.keys.poolKeys(),
    fees: { [zeroAddress]: fees.eth, [network.usdg]: fees.usdg },
  });
  return { user, service, port: new DirectRelayer(service) };
}

export interface ChannelNode {
  p2p: P2PService;
  channels: ChannelService;
  disputes: DisputeService;
}

/** A user's channel node: reachable through the libp2p relay, answering channel messages. */
export async function newChannelNode(
  user: User,
  chain: ChainAdapter,
  relayAddr: string,
  options: Pick<ChannelDeps, 'approveOpen' | 'confirmPayment'> = {},
): Promise<ChannelNode> {
  const p2p = new P2PService(await createPeerNode({ relays: [relayAddr] }));
  const { wallet, keys, pool } = user;
  const channels = new ChannelService({ wallet, keys, chain, pool, prover, p2p, repository: new ChannelRepository(wallet), ...options });
  await channels.listen();
  await p2p.waitForRelay();
  return { p2p, channels, disputes: new DisputeService({ wallet, keys, chain, pool, prover, channels }) };
}
