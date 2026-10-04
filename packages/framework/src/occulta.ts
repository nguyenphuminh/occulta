import type { Libp2p } from '@libp2p/interface';
import { concat, hexToBytes, keccak256, stringToHex } from 'viem';
import { AppError } from './shared/errors/AppError.ts';
import { Prover, type ArtifactLoader, type ProverPort } from './shared/integrations/prover.ts';
import { BUILT_IN_NETWORKS, ChainAdapter, defaultRpcUrls, tokenAddress, type NetworkConfig } from './modules/chain/index.ts';
import { ChannelRepository, ChannelService, type ChannelDeps, type TickProblem } from './modules/channel/index.ts';
import { DisputeService } from './modules/dispute/index.ts';
import { KeyRing } from './modules/keys/index.ts';
import { P2PService } from './modules/p2p/index.ts';
import { PoolRepository, PoolService } from './modules/pool/index.ts';
import { HttpRelayer, type RelayRequest, type RelayResult, type RelayerInfo, type RelayerPort } from './modules/relayer/index.ts';
import type { KeyValueStore } from './modules/storage/index.ts';
import { WalletRepository, WalletService, type KdfParams } from './modules/wallet/index.ts';

/** Everything an integrator configures through code (BRD 2.2.13). */
export interface OccultaOptions {
  /** Where local data is stored (it only ever holds the encrypted wallet). */
  store: KeyValueStore;
  /** Where the circuits' proving files come from (files in Node.js, URLs in the browser). */
  artifacts: ArtifactLoader;
  /** Proves with this instead of snarkjs on the calling thread (the website proves in a Web Worker). */
  prover?: ProverPort;
  /** Creates the libp2p node: createPeerNode from "./libp2p-node" or createBrowserNode from "./libp2p-browser". */
  createNode: (options: { relays: string[]; seed: Uint8Array }) => Promise<Libp2p>;
  /** Chain configurations; the four built-in ones by default. A custom one is added here. */
  networks?: readonly NetworkConfig[];
  /** libp2p relays to use instead of the network's own list. */
  libp2pRelays?: string[];
  /** The user's own RPC endpoints, tried first and in order (BRD 2.2.13); default: the network's own. */
  rpcUrls?: string[];
  /** When the user's endpoints all fail, use the network's own too (default true). */
  rpcFallback?: boolean;
  /** Transaction relayers to use instead of the network's own list (e.g. an in-process DirectRelayer). */
  relayers?: RelayerPort[];
  /** Highest relayer fee accepted per token (0n = ETH), in base units. Higher quotes are refused. */
  maxFee?: Map<bigint, bigint>;
  /** Dispute window of new channels in seconds, between 3 and 7 days (default 7 days). */
  disputeWindow?: bigint;
  approveOpen?: ChannelDeps['approveOpen'];
  onJoined?: ChannelDeps['onJoined'];
  /** Without it, outgoing channel payments are signed automatically. */
  confirmPayment?: ChannelDeps['confirmPayment'];
  /** Only lowered by tests. */
  kdf?: KdfParams;
}

/** Services bound to the active account on the current network, alive while the wallet is unlocked. */
interface Session {
  accountId: string;
  network: NetworkConfig;
  chain: ChainAdapter;
  pool: PoolService;
  p2p: P2PService | null;
  channels: ChannelService | null;
  disputes: DisputeService | null;
  /** Closed when the session ends, so its unfinished work cannot overwrite the next session's data. */
  stores: { close(): void }[];
}

/**
 * The Occulta channel node: the wallet core plus, once unlocked, the pool, channels, disputes, P2P
 * and relayers of the active account on the selected network. The website and the desktop client
 * are built on this class alone.
 */
export class Occulta {
  readonly wallet: WalletService;
  readonly keys: KeyRing;
  private options: OccultaOptions;
  private readonly prover: ProverPort;
  private session: Session | null = null;

  constructor(options: OccultaOptions) {
    this.options = options;
    this.wallet = new WalletService(new WalletRepository(options.store), options.kdf);
    this.keys = new KeyRing(this.wallet);
    this.prover = options.prover ?? new Prover(options.artifacts);
  }

  /** Changes settings a user can edit (e.g. adding a relay); they apply from the next start(). */
  configure(changes: Partial<Pick<OccultaOptions, 'networks' | 'libp2pRelays' | 'relayers' | 'rpcUrls' | 'rpcFallback' | 'maxFee' | 'disputeWindow'>>): void {
    this.options = { ...this.options, ...changes };
  }

  networks(): readonly NetworkConfig[] {
    return this.options.networks ?? BUILT_IN_NETWORKS;
  }

  /** The selected network's configuration. */
  network(): NetworkConfig {
    const id = this.wallet.networkId();
    const network = this.networks().find((n) => n.id === id);
    if (!network) throw new AppError(404, 'UNKNOWN_NETWORK', `No configuration for network "${id}"`);
    return network;
  }

  /**
   * Starts the services of the active account on the selected network (after unlocking, and after
   * switching account or network). P2P, and with it channels, start only if libp2p relays are known.
   */
  async start(): Promise<void> {
    // The account's libp2p identity must be free before a new node takes it; until the new
    // services are ready, the previous ones stay reachable (their data stays on their own network).
    await this.session?.p2p?.stop();
    const { wallet, keys, prover, options } = this;
    const accountId = wallet.activeAccount().id;
    const network = this.network();
    const chain = new ChainAdapter(network, { rpcUrls: this.rpcUrls() });
    const poolStore = new PoolRepository(wallet, network.id);
    const pool = new PoolService({ wallet, keys, chain, prover, repository: poolStore });
    const session: Session = { accountId, network, chain, pool, p2p: null, channels: null, disputes: null, stores: [poolStore] };
    const relays = options.libp2pRelays ?? network.libp2pRelays;
    if (relays.length > 0) {
      // A stable libp2p identity per account, so invites keep working across restarts.
      const seed = hexToBytes(keccak256(concat([(await keys.poolKeys(accountId)).seed, stringToHex('libp2p')])));
      const p2p = new P2PService(await options.createNode({ relays, seed }));
      const channelStore = new ChannelRepository(wallet, network.id);
      session.stores.push(channelStore);
      const channels = new ChannelService({
        wallet,
        keys,
        chain,
        pool,
        prover,
        p2p,
        repository: channelStore,
        relayer: () => this.relayer(),
        approveOpen: options.approveOpen,
        onJoined: options.onJoined,
        confirmPayment: options.confirmPayment,
        window: options.disputeWindow,
      });
      await channels.listen();
      Object.assign(session, { p2p, channels, disputes: new DisputeService({ wallet, keys, chain, pool, prover, channels }) });
    }
    const previous = this.session;
    this.session = session;
    for (const store of previous?.stores ?? []) store.close();
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    for (const store of session?.stores ?? []) store.close();
    await session?.p2p?.stop();
  }

  /** The RPC endpoints of the selected network, in the order they are tried. */
  rpcUrls(): string[] {
    const own = this.options.rpcUrls ?? [];
    const defaults = defaultRpcUrls(this.network());
    if (own.length === 0) return defaults;
    return [...new Set(this.options.rpcFallback === false ? own : [...own, ...defaults])];
  }

  /** Locks the wallet and forgets every derived key. */
  async lock(): Promise<void> {
    await this.stop();
    this.wallet.lock();
    this.keys.clear();
  }

  get chain(): ChainAdapter {
    return this.current().chain;
  }

  get pool(): PoolService {
    return this.current().pool;
  }

  get p2p(): P2PService {
    return this.withP2P().p2p;
  }

  get channels(): ChannelService {
    return this.withP2P().channels;
  }

  get disputes(): DisputeService {
    return this.withP2P().disputes;
  }

  /** The relayer to use: the first configured one, refusing quotes above the maximum fee. */
  relayer(): RelayerPort {
    const ports = this.options.relayers ?? this.current().network.relayers.map((url) => new HttpRelayer(url));
    const port = ports[0];
    if (!port) throw new AppError(503, 'NO_RELAYER', 'No transaction relayer is configured for this network');
    return new CappedRelayer(port, this.options.maxFee);
  }

  /** Background work, to call periodically: note sync, channel progress and dispute watching. */
  async tick(): Promise<TickProblem[]> {
    const session = this.current();
    await session.pool.sync(session.accountId);
    if (!session.channels || !session.disputes) return [];
    const relayer = this.relayer();
    return [...(await session.channels.tick(relayer, session.accountId)), ...(await session.disputes.tick(relayer, session.accountId))];
  }

  private current(): Session {
    if (!this.session) throw new AppError(409, 'NOT_STARTED', 'Unlock the wallet and start Occulta first');
    return this.session;
  }

  private withP2P(): Required<{ [K in keyof Session]: NonNullable<Session[K]> }> {
    const session = this.current();
    if (!session.p2p || !session.channels || !session.disputes) throw new AppError(503, 'NO_RELAY', 'Channels need a libp2p relay; add one in the network settings');
    return session as Required<{ [K in keyof Session]: NonNullable<Session[K]> }>;
  }
}

/** Refuses relayers whose quote exceeds the configured maximum fee (BRD 2.2.13). */
class CappedRelayer implements RelayerPort {
  private readonly port: RelayerPort;
  private readonly maxFee: Map<bigint, bigint> | undefined;

  constructor(port: RelayerPort, maxFee: Map<bigint, bigint> | undefined) {
    this.port = port;
    this.maxFee = maxFee;
  }

  async info(): Promise<RelayerInfo> {
    const info = await this.port.info();
    for (const [token, max] of this.maxFee ?? []) {
      const quote = info.fees[tokenAddress(token).toLowerCase()];
      if (quote !== undefined && BigInt(quote) > max) throw new AppError(409, 'FEE_ABOVE_MAX', 'The relayer charges more than the maximum fee you accept');
    }
    return info;
  }

  submit(request: RelayRequest): Promise<RelayResult> {
    return this.port.submit(request);
  }
}
