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

  /** Channel nullifiers of disputes started in a block range (to notice disputes on our channels). */
  async disputeEvents(fromBlock: bigint, toBlock: bigint): Promise<{ channelNullifier: bigint; nonce: bigint; deadline: bigint }[]> {
    const { disputes } = this.contracts();
    const events = await this.windows(fromBlock, toBlock, (from, to) =>
      this.client.getContractEvents({ address: disputes, abi: disputesAbi, eventName: 'DisputeSubmitted', fromBlock: from, toBlock: to }),
    );
    return events.map((e) => ({ channelNullifier: e.args.channelNullifier as bigint, nonce: e.args.nonce as bigint, deadline: e.args.deadline as bigint }));
  }

  async isKnownRoot(root: bigint): Promise<boolean> {
    return this.client.readContract({ address: this.contracts().pool, abi: poolAbi, functionName: 'isKnownRoot', args: [root] });
  }

  async disputeOf(channelNullifier: bigint): Promise<Dispute> {
    const [pending, nonce, stateHash, deadline] = await this.client.readContract({
      address: this.contracts().disputes,
      abi: disputesAbi,
      functionName: 'disputeOf',
      args: [channelNullifier],
    });
    return { pending, nonce, stateHash, deadline };
  }

  async isFinalized(channelNullifier: bigint): Promise<boolean> {
    return this.client.readContract({ address: this.contracts().disputes, abi: disputesAbi, functionName: 'isFinalized', args: [channelNullifier] });
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

  /** BRD 2.2.14.4: send ETH or USDG publicly. */
  async sendPublic(account: LocalAccount, token: bigint, to: Address, amount: bigint): Promise<Hex> {
    const wallet = createWalletClient({ account, chain: this.chain, transport: http(this.network.rpcUrl) });
    if (token === 0n) return this.confirm(await wallet.sendTransaction({ account, chain: this.chain, to, value: amount }));
    return this.confirm(await wallet.writeContract({ account, chain: this.chain, address: tokenAddress(token), abi: erc20Abi, functionName: 'transfer', args: [to, amount] }));
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
