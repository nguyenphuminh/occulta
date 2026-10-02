import { BaseError, ContractFunctionRevertedError, createWalletClient, hexToBytes, http, type Abi, type Address, type LocalAccount } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import { CIPHERTEXT_SIZE, decryptNote, noteCommitment } from '../../shared/protocol/index.ts';
import { disputesAbi, poolAbi, tokenAddress, type ChainAdapter } from '../chain/index.ts';
import { shieldedAddressOf, type PoolKeys } from '../keys/index.ts';
import { RelayRequestSchema, type RelayRequest, type RelayResult, type RelayerInfo } from './relayer.schema.ts';

/** Position of the fee note's commitment in each kind of public signals. */
const FEE_SIGNAL: Record<Exclude<RelayRequest['kind'], 'submitState'>, number> = { transact: 8, finalize: 6, reclaim: 6 };

export interface RelayerOptions {
  /** The relayer's own account: pays gas, and its pool keys receive the fee notes. */
  account: LocalAccount;
  keys: PoolKeys;
  /** Minimum fee per accepted token (zero address = ETH), in the token's base units. */
  fees: Record<Address, bigint>;
}

/**
 * The relayer (BRD 2.2.11): submits users' proven transactions from its own account and pays the
 * gas. It is paid only through its private fee note, which it decrypts and checks before submitting.
 * Submitting a dispute state carries no fee note and is relayed for free.
 */
export class RelayerService {
  private readonly chain: ChainAdapter;
  private readonly options: RelayerOptions;
  /** One transaction at a time, so the relayer account's nonces never collide. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(chain: ChainAdapter, options: RelayerOptions) {
    this.chain = chain;
    this.options = options;
  }

  info(): RelayerInfo {
    return {
      chainId: this.chain.network.chainId,
      shieldedAddress: shieldedAddressOf(this.options.keys),
      fees: Object.fromEntries(Object.entries(this.options.fees).map(([token, fee]) => [token.toLowerCase(), fee.toString()])),
    };
  }

  async relay(input: unknown): Promise<RelayResult> {
    const request = RelayRequestSchema.parse(input);
    if (request.kind !== 'submitState') this.checkFeeNote(request.ciphertexts, BigInt(request.signals[FEE_SIGNAL[request.kind]] as string));
    const run = this.queue.then(() => this.send(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkFeeNote(ciphertexts: `0x${string}`, commitment: bigint): void {
    const bytes = hexToBytes(ciphertexts);
    if (bytes.length !== 3 * CIPHERTEXT_SIZE) throw new AppError(400, 'BAD_CIPHERTEXTS', 'Expected three note ciphertexts');
    const note = decryptNote(this.options.keys.encryption, bytes.slice(2 * CIPHERTEXT_SIZE));
    if (!note || note.ownerTag !== this.options.keys.ownerTag) throw new AppError(402, 'NO_FEE_NOTE', 'The third output is not a fee note for this relayer');
    if (noteCommitment(note) !== commitment) throw new AppError(402, 'FEE_NOTE_MISMATCH', 'The fee note does not match its commitment in the proof');
    const required = Object.entries(this.options.fees).find(([token]) => token.toLowerCase() === tokenAddress(note.token).toLowerCase())?.[1];
    if (required === undefined) throw new AppError(402, 'TOKEN_NOT_ACCEPTED', 'This relayer does not accept fees in that token');
    if (note.amount < required) throw new AppError(402, 'FEE_TOO_LOW', `The fee is below this relayer's quote of ${required}`);
  }

  private async send(request: RelayRequest): Promise<RelayResult> {
    const { pool, disputes } = this.chain.contracts();
    const proof = request.proof.map(BigInt);
    const signals = request.signals.map(BigInt);
    const call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } =
      request.kind === 'transact'
        ? { address: pool, abi: poolAbi, functionName: 'transact', args: [proof, signals, request.recipient, request.ciphertexts] }
        : request.kind === 'submitState'
          ? { address: disputes, abi: disputesAbi, functionName: 'submitState', args: [proof, signals] }
          : { address: disputes, abi: disputesAbi, functionName: request.kind, args: [proof, signals, request.ciphertexts] };
    const account = this.options.account;
    try {
      await this.chain.client.simulateContract({ ...call, account } as never);
    } catch (err) {
      const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      const reason = reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? reverted.shortMessage) : 'unknown reason';
      throw new AppError(422, 'WOULD_REVERT', `The transaction would fail on-chain: ${reason}`);
    }
    const wallet = createWalletClient({ account, chain: this.chain.chain, transport: http(this.chain.network.rpcUrl) });
    const txHash = await wallet.writeContract({ ...call, account, chain: this.chain.chain } as never);
    const receipt = await this.chain.client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new AppError(502, 'TRANSACTION_FAILED', `Transaction ${txHash} failed`);
    return { txHash };
  }
}
