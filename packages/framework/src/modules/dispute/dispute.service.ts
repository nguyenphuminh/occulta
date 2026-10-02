import { bytesToHex, concatHex, zeroAddress, type Hex } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import {
  channelNullifierOf,
  dummyInput,
  encryptNote,
  extDataHashOf,
  finalizeWitness,
  noteCommitment,
  nullifierOf,
  randomFieldElement,
  reclaimWitness,
  submitStateWitness,
  type NotePreimage,
} from '../../shared/protocol/index.ts';
import type { ChainAdapter } from '../chain/index.ts';
import {
  contributionsOf,
  hashOf,
  payoutNote,
  settlement,
  sideOf,
  signedStates,
  type ChannelRecord,
  type ChannelService,
  type TickProblem,
} from '../channel/index.ts';
import { channelSecrets, decodeShieldedAddress, type KeyRing } from '../keys/index.ts';
import type { PoolService } from '../pool/index.ts';
import { quotedFee, type RelayerPort } from '../relayer/index.ts';
import type { WalletService } from '../wallet/index.ts';

export interface DisputeDeps {
  wallet: WalletService;
  keys: KeyRing;
  chain: ChainAdapter;
  pool: PoolService;
  prover: ProverPort;
  channels: ChannelService;
}

type Signed = ChannelRecord['latest'];

/** Channels that can still be disputed or settled. */
const WATCHED = new Set<ChannelRecord['status']>(['funding', 'live', 'closing', 'disputing']);

/**
 * Unilateral close (BRD 2.2.10): starts a dispute with the best state this side holds, answers a
 * dispute with a newer state, finalizes after the deadline, then adds this side's payout to its
 * notes and reclaims a contribution the settled state left out. Everything goes through a relayer.
 */
export class DisputeService {
  private readonly deps: DisputeDeps;

  constructor(deps: DisputeDeps) {
    this.deps = deps;
  }

  /** Starts a dispute, e.g. because the other side stopped answering. */
  async start(id: string, relayer: RelayerPort, accountId?: string): Promise<Hex> {
    return this.deps.channels.update(
      id,
      async (r) => {
        if (!WATCHED.has(r.status)) throw new AppError(409, 'NOT_DISPUTABLE', 'This channel is already closed');
        const best = await this.bestState(r);
        if (!best) throw new AppError(409, 'NOT_DISPUTABLE', 'No state of this channel can be proven yet (its contributions are not in the pool)');
        const txHash = await this.submitState(r, best, relayer);
        r.status = 'disputing';
        return txHash;
      },
      accountId,
    );
  }

  /**
   * Watches the account's channels (call it periodically, more often than the shortest dispute
   * window): answers disputes, finalizes once the deadline passed, settles finalized channels.
   */
  async tick(relayer: RelayerPort, accountId?: string): Promise<TickProblem[]> {
    const { wallet, channels } = this.deps;
    const account = accountId ?? wallet.activeAccount().id;
    const problems: TickProblem[] = [];
    for (const { id, status } of channels.list(account)) {
      if (!WATCHED.has(status)) continue;
      try {
        await channels.update(id, (r) => this.advance(r, relayer, account), account);
      } catch (error) {
        problems.push({ channelId: id, error });
      }
    }
    return problems;
  }

  private async advance(r: ChannelRecord, relayer: RelayerPort, account: string): Promise<void> {
    const { chain } = this.deps;
    const channelNullifier = channelNullifierOf(r.params.channelSecret);
    const dispute = await chain.disputeOf(channelNullifier);
    if (await chain.isFinalized(channelNullifier)) return this.settle(r, dispute.stateHash, relayer, account);
    if (!dispute.pending) return;
    r.status = 'disputing';
    const best = await this.bestState(r);
    if (best && best.state.nonce > dispute.nonce) {
      await this.submitState(r, best, relayer);
      return;
    }
    if ((await chain.blockTimestamp()) < dispute.deadline) return;
    const pending = [r.latest, r.state0].find((x) => x.sigA && x.sigB && hashOf(r, x.state) === dispute.stateHash);
    // Without both signatures of the pending state (an old state the other side submitted), only
    // the other side can finalize; this side settles once it has.
    if (!pending) return;
    await this.finalize(r, pending, relayer);
    await this.settle(r, dispute.stateHash, relayer, account);
  }

  /** The highest state signed by both sides whose listed contributions are all in the pool. */
  private async bestState(r: ChannelRecord): Promise<Signed | null> {
    const { pool } = this.deps;
    await pool.refreshChain();
    const candidates = [r.latest, r.state0].filter((x) => x.sigA && x.sigB && x.state.contribs.every((c) => c === 0n || pool.hasCommitment(c)));
    return candidates.sort((a, b) => (a.state.nonce > b.state.nonce ? -1 : 1))[0] ?? null;
  }

  private async submitState(r: ChannelRecord, signed: Signed, relayer: RelayerPort): Promise<Hex> {
    const { pool, prover } = this.deps;
    const { state, sigA, sigB } = signed;
    if (!sigA || !sigB) throw new AppError(409, 'NOT_SIGNED', 'The state is not signed by both sides');
    await pool.refreshChain();
    const proofOf = (c: bigint) => (c === 0n ? pool.emptyProof() : pool.proofOf(c));
    const witness = submitStateWitness({
      root: pool.root,
      channel: { params: r.params, state, sigA, sigB },
      contribProofs: [proofOf(state.contribs[0]), proofOf(state.contribs[1])],
    });
    const { proof, signals } = await prover.prove('submit_state', witness.input);
    return (await relayer.submit({ kind: 'submitState', proof: proof.map(String), signals: signals.map(String) })).txHash;
  }

  private async finalize(r: ChannelRecord, signed: Signed, relayer: RelayerPort): Promise<void> {
    const { pool, prover } = this.deps;
    const { state, sigA, sigB } = signed;
    if (!sigA || !sigB) throw new AppError(409, 'NOT_SIGNED', 'The state is not signed by both sides');
    await pool.refreshChain();
    const info = await relayer.info();
    const { inputs, outputs, ciphertexts } = settlement(r, state, (c) => pool.proofOf(c), decodeShieldedAddress(info.shieldedAddress));
    const witness = finalizeWitness({
      root: pool.root,
      token: r.token,
      inputs,
      outputs,
      extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts }),
      channel: { params: r.params, state, sigA, sigB },
    });
    const { proof, signals } = await prover.prove('finalize', witness.input);
    await relayer.submit({ kind: 'finalize', proof: proof.map(String), signals: signals.map(String), ciphertexts: concatHex(ciphertexts) });
  }

  /** After finalization: adds this side's payout to its notes and reclaims its contribution if the state left it out. */
  private async settle(r: ChannelRecord, stateHash: bigint, relayer: RelayerPort, account: string): Promise<void> {
    const { pool } = this.deps;
    await pool.sync(account);
    const settled = signedStates(r)
      .reverse()
      .find((s) => hashOf(r, s) === stateHash);
    if (settled) await pool.adopt(payoutNote(r, settled, sideOf(r)), { channel: r.index }, account);
    // Finalize spends every contribution the state lists, so one still unspent was left out.
    const own = contributionsOf(r)[sideOf(r)];
    if (own) {
      const commitment = noteCommitment(own);
      if (pool.hasCommitment(commitment) && !pool.isSpent(nullifierOf(r.params.channelSecret, commitment))) await this.reclaim(r, own, relayer, account);
    }
    r.status = 'settled';
  }

  private async reclaim(r: ChannelRecord, contribution: NotePreimage, relayer: RelayerPort, account: string): Promise<void> {
    const { keys, pool, prover } = this.deps;
    const poolKeys = await keys.poolKeys(account);
    const info = await relayer.info();
    const fee = quotedFee(info, r.token);
    if (contribution.amount <= fee) throw new AppError(409, 'FEE_EXCEEDS_CONTRIBUTION', 'The relayer fee is larger than the contribution to reclaim');
    const feeTo = decodeShieldedAddress(info.shieldedAddress);
    const own = (amount: bigint): NotePreimage => ({ amount, token: r.token, ownerTag: poolKeys.ownerTag, salt: randomFieldElement() });
    const outputs: [NotePreimage, NotePreimage, NotePreimage] = [own(contribution.amount - fee), own(0n), { amount: fee, token: r.token, ownerTag: feeTo.ownerTag, salt: randomFieldElement() }];
    const ciphertexts: [Hex, Hex, Hex] = [
      bytesToHex(encryptNote(poolKeys.encryption.publicKey, outputs[0])),
      bytesToHex(encryptNote(poolKeys.encryption.publicKey, outputs[1])),
      bytesToHex(encryptNote(feeTo.encryptionPublicKey, outputs[2])),
    ];
    const witness = reclaimWitness({
      root: pool.root,
      token: r.token,
      contribution: { note: contribution, proof: pool.proofOf(noteCommitment(contribution)) },
      refundSecret: channelSecrets(poolKeys, r.index).tagSecret,
      extra: dummyInput(r.token),
      params: r.params,
      outputs,
      extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts }),
    });
    const { proof, signals } = await prover.prove('reclaim', witness.input);
    await relayer.submit({ kind: 'reclaim', proof: proof.map(String), signals: signals.map(String), ciphertexts: concatHex(ciphertexts) });
    await pool.sync(account);
  }
}
