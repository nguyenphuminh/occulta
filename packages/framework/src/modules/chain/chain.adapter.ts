import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  ExecutionRevertedError,
  HttpRequestError,
  http,
  RpcRequestError,
  TimeoutError,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import { disputesAbi, erc20Abi, poolAbi } from './chain.abi.ts';
import type { NetworkConfig } from './chain.config.ts';

export interface CommitmentEvent {
  commitment: bigint;
  leafIndex: number;
  ciphertext: Hex;
  blockNumber: bigint;
}

export interface Dispute {
  pending: boolean;
  nonce: bigint;
  stateHash: bigint;
  deadline: bigint;
}

/** Event scans ask for this many blocks at a time, and for fewer when an endpoint refuses the range. */
const LOG_WINDOW = 50_000n;
const MIN_LOG_WINDOW = 500n;
/** An endpoint that failed is passed over this long before the more preferred ones are tried again. */
const RETRY_AFTER_MS = 60_000;

/** The network's own RPC endpoints, in order: the main one, then the others it lists. */
export const defaultRpcUrls = (network: NetworkConfig): string[] => [network.rpcUrl, ...(network.backupRpcUrls ?? [])];

/** The chain ID an RPC endpoint answers with, for checking an endpoint before it is saved. */
export async function chainIdAt(url: string): Promise<number> {
  try {
    return await createPublicClient({ transport: http(url, { retryCount: 0, timeout: 10_000 }) }).getChainId();
  } catch {
    throw new AppError(503, 'RPC_UNREACHABLE', 'This RPC endpoint does not answer');
  }
}

interface Endpoint {
  url: string;
  client: PublicClient;
  /** How many blocks one event query may span here; halved when the endpoint refuses a range. */
  logWindow: bigint;
  failedAt: number;
  /** Its chain ID was checked; an endpoint of another chain is never used. */
  checked: boolean;
  wrongChain: boolean;
}

export interface ChainAdapterOptions {
  /** RPC endpoints in order of preference (default: the network's own). */
  rpcUrls?: readonly string[];
  /** How long a failed endpoint is passed over (tests shorten it). */
  retryAfterMs?: number;
  /** Blocks per event query at first, and the fewest it shrinks to (tests shorten both). */
  logWindow?: bigint;
  minLogWindow?: bigint;
}

/** A failure of the endpoint itself (down, overloaded, timed out, of another chain), not an answer such as a revert. */
function endpointFailed(err: unknown): boolean {
  if (isAppError(err)) return err.code === 'WRONG_CHAIN';
  if (!(err instanceof BaseError)) return err instanceof TypeError; // fetch failed
  if (err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError)) return false;
  return Boolean(err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError));
}

/** An endpoint refusing an event query for spanning too many blocks or returning too many events. */
const rangeRefused = (err: unknown): boolean => err instanceof BaseError && /range|blocks|too (many|large)|exceed|limit|more than/i.test(err.details ?? err.message);

export const tokenAddress = (token: bigint): Address => (token === 0n ? zeroAddress : (`0x${token.toString(16).padStart(40, '0')}` as Address));

/**
 * All chain access for one network: pool and dispute reads, event scans and the user's own
 * transactions, through the first RPC endpoint that answers. A read runs on one endpoint from start
 * to finish, so that answers from endpoints at different heights are never mixed (a lagging one
 * would report no events for blocks it has not seen yet); if that endpoint fails, the read runs
 * again on the next one. A transaction is never sent again through another endpoint.
 */
export class ChainAdapter {
  readonly network: NetworkConfig;
  readonly chain: Chain;
  private readonly endpoints: Endpoint[];
  private readonly retryAfterMs: number;
  private readonly minLogWindow: bigint;
  /** Every dispute seen in the contract's events, scanned up to `scannedTo`. */
  private readonly disputeMirror = { scannedTo: -1n, disputes: new Map<bigint, Dispute>(), finalized: new Set<bigint>() };
  private mirroring: Promise<void> | null = null;

  constructor(network: NetworkConfig, options: ChainAdapterOptions = {}) {
    this.network = network;
    this.chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
    });
    const urls = [...new Set(options.rpcUrls?.length ? options.rpcUrls : defaultRpcUrls(network))];
    this.endpoints = urls.map((url) => ({
      url,
      client: createPublicClient({ chain: this.chain, transport: http(url, { retryCount: 1, timeout: 15_000 }) }),
      logWindow: options.logWindow ?? LOG_WINDOW,
      failedAt: Number.NEGATIVE_INFINITY,
      checked: false,
      wrongChain: false,
    }));
    this.retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
    this.minLogWindow = options.minLogWindow ?? MIN_LOG_WINDOW;
  }

  /** The endpoint a read would use now: the most preferred one that has not failed lately. */
  get rpcUrl(): string {
    return (this.endpoints[this.order()[0] ?? 0] as Endpoint).url;
  }

  /** The client of that endpoint. */
  get client(): PublicClient {
    return (this.endpoints[this.order()[0] ?? 0] as Endpoint).client;
  }

  contracts(): NonNullable<NetworkConfig['contracts']> {
    if (!this.network.contracts) throw new AppError(409, 'NOT_DEPLOYED', `Occulta is not deployed on ${this.network.name} yet`);
    return this.network.contracts;
  }

  /** Endpoints to try, in order: those that did not fail lately as listed, then the ones that failed longest ago. */
  private order(): number[] {
    const now = Date.now();
    const usable = this.endpoints.map((e, i) => ({ e, i })).filter(({ e }) => !e.wrongChain);
    const fresh = usable.filter(({ e }) => now - e.failedAt >= this.retryAfterMs);
    const failed = usable.filter(({ e }) => now - e.failedAt < this.retryAfterMs).sort((a, b) => a.e.failedAt - b.e.failedAt);
    return [...fresh, ...failed].map(({ i }) => i);
  }

  private async check(endpoint: Endpoint): Promise<void> {
    if (endpoint.checked) return;
    const chainId = await endpoint.client.getChainId();
    if (chainId !== this.network.chainId) {
      endpoint.wrongChain = true;
      throw new AppError(502, 'WRONG_CHAIN', `${endpoint.url} serves chain ${chainId}, not ${this.network.name}`);
    }
    endpoint.checked = true;
  }

  /** Runs a read on one endpoint from start to finish, and again on the next one if that endpoint fails. */
  private async read<T>(run: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    for (const i of this.order()) {
      const endpoint = this.endpoints[i] as Endpoint;
      try {
        await this.check(endpoint);
        return await run(endpoint);
      } catch (err) {
        if (!endpointFailed(err)) throw err;
        endpoint.failedAt = Date.now();
      }
    }
    throw new AppError(503, 'RPC_UNAVAILABLE', `No RPC endpoint of ${this.network.name} is answering`);
  }

  /** The endpoint for a transaction: the first that answers. The transaction then stays on it. */
  private async forTransaction(): Promise<Endpoint> {
    return this.read(async (endpoint) => endpoint);
  }

  /** Uncached: a sync right after a transaction must see that transaction's block. */
  latestBlock(): Promise<bigint> {
    return this.read((e) => e.client.getBlockNumber({ cacheTime: 0 }));
  }

  /** Runs an event query over [from, to] in windows the endpoint accepts. */
  private async windows<T>(endpoint: Endpoint, from: bigint, to: bigint, scan: (client: PublicClient, from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let start = from; start <= to; ) {
      const end = start + endpoint.logWindow - 1n < to ? start + endpoint.logWindow - 1n : to;
      try {
        out.push(...(await scan(endpoint.client, start, end)));
        start = end + 1n;
      } catch (err) {
        if (!rangeRefused(err) || endpoint.logWindow <= this.minLogWindow) throw err;
        endpoint.logWindow /= 2n; // smaller queries from now on, for this endpoint
      }
    }
    return out;
  }

  /** The pool's new notes and spent nullifiers from `fromBlock` up to the latest block, all from one endpoint. */
  async poolEvents(fromBlock: bigint): Promise<{ toBlock: bigint; commitments: CommitmentEvent[]; nullifiers: bigint[] }> {
    const { pool } = this.contracts();
    return this.read(async (endpoint) => {
      const toBlock = await endpoint.client.getBlockNumber({ cacheTime: 0 });
      if (fromBlock > toBlock) return { toBlock, commitments: [], nullifiers: [] };
      const [created, spent] = await Promise.all([
        this.windows(endpoint, fromBlock, toBlock, (client, from, to) => client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock: from, toBlock: to })),
        this.windows(endpoint, fromBlock, toBlock, (client, from, to) => client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewNullifier', fromBlock: from, toBlock: to })),
      ]);
      const commitments = created
        .map((e) => ({ commitment: e.args.commitment as bigint, leafIndex: Number(e.args.leafIndex), ciphertext: e.args.ciphertext as Hex, blockNumber: e.blockNumber as bigint }))
        .sort((a, b) => a.leafIndex - b.leafIndex);
      return { toBlock, commitments, nullifiers: spent.map((e) => e.args.nullifier as bigint) };
    });
  }

  /**
   * Catches up with every dispute the contract has seen, from its events. Asking the contract about
   * one channel would tell the RPC provider which channel nullifiers belong to this user (BRD 2.2.4).
   */
  refreshDisputes(): Promise<void> {
    this.mirroring ??= this.scanDisputes().finally(() => {
      this.mirroring = null;
    });
    return this.mirroring;
  }

  private async scanDisputes(): Promise<void> {
    const { disputes, deployBlock } = this.contracts();
    const mirror = this.disputeMirror;
    const from = mirror.scannedTo < 0n ? deployBlock : mirror.scannedTo + 1n;
    const scan = await this.read(async (endpoint) => {
      const to = await endpoint.client.getBlockNumber({ cacheTime: 0 });
      if (from > to) return null;
      const [submitted, finalized] = await Promise.all([
        this.windows(endpoint, from, to, (client, f, t) => client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'DisputeSubmitted', fromBlock: f, toBlock: t })),
        this.windows(endpoint, from, to, (client, f, t) => client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'ChannelFinalized', fromBlock: f, toBlock: t })),
      ]);
      return { to, submitted, finalized };
    });
    if (!scan) return;
    // In chain order, so the latest submission for a channel wins; a finalized dispute is no longer pending.
    for (const e of scan.submitted) {
      mirror.disputes.set(e.args.channelNullifier as bigint, { pending: true, nonce: e.args.nonce as bigint, stateHash: e.args.stateHash as bigint, deadline: e.args.deadline as bigint });
    }
    for (const e of scan.finalized) {
      const channelNullifier = e.args.channelNullifier as bigint;
      mirror.finalized.add(channelNullifier);
      const dispute = mirror.disputes.get(channelNullifier);
      if (dispute) mirror.disputes.set(channelNullifier, { ...dispute, pending: false });
    }
    mirror.scannedTo = scan.to;
  }

  async isKnownRoot(root: bigint): Promise<boolean> {
    return this.read((e) => e.client.readContract({ address: this.contracts().pool, abi: poolAbi, functionName: 'isKnownRoot', args: [root] }));
  }

  /** The channel's dispute as the contract holds it: the latest submitted state and its deadline. */
  async disputeOf(channelNullifier: bigint): Promise<Dispute> {
    await this.refreshDisputes();
    return this.disputeMirror.disputes.get(channelNullifier) ?? { pending: false, nonce: 0n, stateHash: 0n, deadline: 0n };
  }

  async isFinalized(channelNullifier: bigint): Promise<boolean> {
    await this.refreshDisputes();
    return this.disputeMirror.finalized.has(channelNullifier);
  }

  /** Shortest and longest dispute window the deployed contract accepts, in seconds. */
  async windowBounds(): Promise<{ min: bigint; max: bigint }> {
    const [min, max] = await this.read((e) => e.client.readContract({ address: this.contracts().disputes, abi: disputesAbi, functionName: 'windowBounds' }));
    return { min, max };
  }

  async blockTimestamp(): Promise<bigint> {
    return (await this.read((e) => e.client.getBlock())).timestamp;
  }

  async publicBalance(owner: Address, token: bigint): Promise<bigint> {
    return this.read((e) =>
      token === 0n ? e.client.getBalance({ address: owner }) : e.client.readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    );
  }

  // --- transactions from the user's own (public) address ---

  private async confirm(endpoint: Endpoint, hash: Hex): Promise<Hex> {
    const receipt = await endpoint.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new AppError(502, 'TRANSACTION_FAILED', `Transaction ${hash} failed`);
    return hash;
  }

  /** BRD 2.2.2: the account deposits; USDG is approved first, ETH is sent with the deposit. */
  async deposit(account: LocalAccount, token: bigint, amount: bigint, inner: bigint, ciphertext: Hex): Promise<Hex> {
    const endpoint = await this.forTransaction();
    const wallet = createWalletClient({ account, chain: this.chain, transport: http(endpoint.url) });
    const { pool } = this.contracts();
    if (token !== 0n) {
      const allowance = await endpoint.client.readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'allowance', args: [account.address, pool] });
      if (allowance < amount) {
        await this.confirm(endpoint, await wallet.writeContract({ account, chain: this.chain, address: tokenAddress(token), abi: erc20Abi, functionName: 'approve', args: [pool, amount] }));
      }
    }
    return this.confirm(
      endpoint,
      await wallet.writeContract({
        account,
        chain: this.chain,
        address: pool,
        abi: poolAbi,
        functionName: 'deposit',
        args: [tokenAddress(token), amount, inner, ciphertext],
        value: token === 0n ? amount : 0n,
      }),
    );
  }
}
