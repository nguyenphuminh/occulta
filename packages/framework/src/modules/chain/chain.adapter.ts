import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
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

/** Event scans are split into windows that public RPC endpoints accept. */
const LOG_WINDOW = 50_000n;

export const tokenAddress = (token: bigint): Address => (token === 0n ? zeroAddress : (`0x${token.toString(16).padStart(40, '0')}` as Address));

/** All chain access for one network: pool and dispute reads, event scans and the user's own transactions. */
export class ChainAdapter {
  readonly network: NetworkConfig;
  readonly chain: Chain;
  readonly client: PublicClient;
  /** Every dispute seen in the contract's events, scanned up to `scannedTo`. */
  private readonly disputeMirror = { scannedTo: -1n, disputes: new Map<bigint, Dispute>(), finalized: new Set<bigint>() };
  private mirroring: Promise<void> | null = null;

  constructor(network: NetworkConfig) {
    this.network = network;
    this.chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
    });
    this.client = createPublicClient({ chain: this.chain, transport: http(network.rpcUrl) });
  }

  contracts(): NonNullable<NetworkConfig['contracts']> {
    if (!this.network.contracts) throw new AppError(409, 'NOT_DEPLOYED', `Occulta is not deployed on ${this.network.name} yet`);
    return this.network.contracts;
  }

  /** Uncached: a sync right after a transaction must see that transaction's block. */
  latestBlock(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  private async windows<T>(from: bigint, to: bigint, scan: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let start = from; start <= to; start += LOG_WINDOW) {
      const end = start + LOG_WINDOW - 1n < to ? start + LOG_WINDOW - 1n : to;
      out.push(...(await scan(start, end)));
    }
    return out;
  }

  async commitments(fromBlock: bigint, toBlock: bigint): Promise<CommitmentEvent[]> {
    const { pool } = this.contracts();
    const events = await this.windows(fromBlock, toBlock, (from, to) =>
      this.client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock: from, toBlock: to }),
    );
    return events
      .map((e) => ({ commitment: e.args.commitment as bigint, leafIndex: Number(e.args.leafIndex), ciphertext: e.args.ciphertext as Hex, blockNumber: e.blockNumber as bigint }))
      .sort((a, b) => a.leafIndex - b.leafIndex);
  }

  async nullifiers(fromBlock: bigint, toBlock: bigint): Promise<bigint[]> {
    const { pool } = this.contracts();
    const events = await this.windows(fromBlock, toBlock, (from, to) =>
      this.client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewNullifier', fromBlock: from, toBlock: to }),
    );
    return events.map((e) => e.args.nullifier as bigint);
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
    const to = await this.latestBlock();
    const from = mirror.scannedTo < 0n ? deployBlock : mirror.scannedTo + 1n;
    if (from > to) return;
    const [submitted, finalized] = await Promise.all([
      this.windows(from, to, (f, t) => this.client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'DisputeSubmitted', fromBlock: f, toBlock: t })),
      this.windows(from, to, (f, t) => this.client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'ChannelFinalized', fromBlock: f, toBlock: t })),
    ]);
    // In chain order, so the latest submission for a channel wins; a finalized dispute is no longer pending.
    for (const e of submitted) {
      mirror.disputes.set(e.args.channelNullifier as bigint, { pending: true, nonce: e.args.nonce as bigint, stateHash: e.args.stateHash as bigint, deadline: e.args.deadline as bigint });
    }
    for (const e of finalized) {
      const channelNullifier = e.args.channelNullifier as bigint;
      mirror.finalized.add(channelNullifier);
      const dispute = mirror.disputes.get(channelNullifier);
      if (dispute) mirror.disputes.set(channelNullifier, { ...dispute, pending: false });
    }
    mirror.scannedTo = to;
  }

  async isKnownRoot(root: bigint): Promise<boolean> {
    return this.client.readContract({ address: this.contracts().pool, abi: poolAbi, functionName: 'isKnownRoot', args: [root] });
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
    const [min, max] = await this.client.readContract({ address: this.contracts().disputes, abi: disputesAbi, functionName: 'windowBounds' });
    return { min, max };
  }

  async blockTimestamp(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }

  // --- transactions from the user's own (public) address ---

  private async confirm(hash: Hex): Promise<Hex> {
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new AppError(502, 'TRANSACTION_FAILED', `Transaction ${hash} failed`);
    return hash;
  }

  async publicBalance(owner: Address, token: bigint): Promise<bigint> {
    if (token === 0n) return this.client.getBalance({ address: owner });
    return this.client.readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  }

  /** BRD 2.2.2: the account deposits; USDG is approved first, ETH is sent with the deposit. */
  async deposit(account: LocalAccount, token: bigint, amount: bigint, inner: bigint, ciphertext: Hex): Promise<Hex> {
    const wallet = createWalletClient({ account, chain: this.chain, transport: http(this.network.rpcUrl) });
    const { pool } = this.contracts();
    if (token !== 0n) {
      const allowance = await this.client.readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'allowance', args: [account.address, pool] });
      if (allowance < amount) {
        await this.confirm(await wallet.writeContract({ account, chain: this.chain, address: tokenAddress(token), abi: erc20Abi, functionName: 'approve', args: [pool, amount] }));
      }
    }
    return this.confirm(
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
