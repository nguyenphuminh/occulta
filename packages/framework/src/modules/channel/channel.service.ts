import { bytesToHex, concatHex, zeroAddress } from 'viem';
import type { z } from 'zod';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import {
  FIELD_SIZE,
  MAX_AMOUNT,
  channelNullifierOf,
  channelPublicKeyOf,
  extDataHashOf,
  hash2,
  noteCommitment,
  nullifierOf,
  ownerTagOf,
  randomFieldElement,
  signStateHash,
  transferWitness,
  type ChannelState,
  type StateSignature,
} from '../../shared/protocol/index.ts';
import type { ChainAdapter } from '../chain/index.ts';
import { channelSecrets, decodeShieldedAddress, type KeyRing } from '../keys/index.ts';
import type { Invite, P2PService } from '../p2p/index.ts';
import type { PoolService } from '../pool/index.ts';
import { quotedFee, type RelayerPort } from '../relayer/index.ts';
import type { WalletService } from '../wallet/index.ts';
import type { ChannelRepository } from './channel.repository.ts';
import {
  ChannelMessageSchema,
  ConfirmReplySchema,
  OpenReplySchema,
  ProposeReplySchema,
  type ChannelRecord,
  type ConfirmMessage,
  type OpenMessage,
  type ProposeMessage,
} from './channel.schema.ts';
import {
  MAX_NONCE,
  balanceOf,
  contributionCommitments,
  contributionNote,
  contributionsOf,
  hashOf,
  historyEntry,
  holdsState,
  nonceStep,
  openingState,
  payoutNote,
  publicKeyOf,
  settlement,
  sideOf,
  signedBy,
  stateFromEntry,
  successorProblem,
  winsTieBreak,
  type Side,
} from './channel.state.ts';

/** How long the invitee waits before it may cancel an opening itself, so that the opener has had time to fund (BRD 2.2.7). */
export const INVITEE_CANCEL_AFTER_MS = 10 * 60_000;

/** How often one payment is re-proposed after losing a tie-break before giving up. */
const PROPOSE_ATTEMPTS = 5;
const CONFLICT_WAIT_MS = 15_000;
/** Refusals after which the other side will never sign the proposal, so it is dropped. */
const FINAL_REFUSALS = new Set(['PROPOSAL_REFUSED', 'STALE_STATE', 'BAD_SIGNATURE', 'BAD_MESSAGE', 'NOT_LIVE', 'CHANNEL_NOT_FOUND']);

/** A channel someone proposes to this side, as shown to the host for approval. */
export interface OpenRequest {
  channelId: string;
  peerId: string;
  token: bigint;
  /** What the opener funds. */
  amount: bigint;
  /** What the opener asks this side to fund. */
  peerAmount: bigint;
  window: bigint;
  closingFee: bigint;
}

export interface ChannelDeps {
  wallet: WalletService;
  keys: KeyRing;
  chain: ChainAdapter;
  pool: PoolService;
  prover: ProverPort;
  p2p: P2PService;
  repository: ChannelRepository;
  /**
   * Decides on channels peers propose. Without it, channels this side does not fund are accepted
   * (it shared its invite for that) and channels that need its money are refused.
   */
  approveOpen?: (request: OpenRequest) => Promise<boolean>;
  /** Called once this side has joined a channel the other side proposed and saved it, before funding. */
  onJoined?: (channelId: string) => void;
  /** Asked before every outgoing payment (BRD 2.2.13); without it payments are signed automatically. */
  confirmPayment?: (payment: { channelId: string; token: bigint; amount: bigint }) => Promise<boolean>;
  /** Dispute window of new channels in seconds (default: the longest the contract accepts, 7 days). */
  window?: bigint;
}

export interface OpenOptions {
  token: bigint;
  /** What this side funds. */
  amount: bigint;
  /** What the other side is asked to fund (default 0). */
  peerAmount?: bigint;
  /** Dispute window in seconds (default: the service's configured window). */
  window?: bigint;
  relayer: RelayerPort;
  accountId?: string;
  /** Called once the other side has accepted and the channel is saved, before this side funds it. */
  onAccepted?: (channelId: string) => void;
}

export interface TickProblem {
  channelId: string;
  error: unknown;
}

type Signed = ChannelRecord['latest'];

/**
 * Two-party channels inside the pool (BRD 2.2.7–2.2.9): opening and funding, off-chain payments
 * signed by both channel keys, and the cooperative close. Messages travel over P2PService only.
 * Every change to a channel happens under its lock; no lock is held while waiting for the peer.
 */
export class ChannelService {
  private readonly deps: ChannelDeps;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: ChannelDeps) {
    this.deps = deps;
  }

  /** Starts answering peers' channel messages. */
  async listen(): Promise<void> {
    await this.deps.p2p.listen((from, message) => this.handle(from, message));
  }

  list(accountId?: string): ChannelRecord[] {
    return this.deps.repository.all(accountId);
  }

  get(id: string, accountId?: string): ChannelRecord {
    const record = this.deps.repository.get(id, accountId);
    if (!record) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'No such channel');
    return record;
  }

  /** Changes a channel with nothing else touching it meanwhile (for the dispute service). */
  update<T>(id: string, change: (r: ChannelRecord) => Promise<T>, accountId?: string): Promise<T> {
    return this.locked(id, async () => {
      const r = this.get(id, accountId);
      try {
        return await change(r);
      } finally {
        await this.deps.repository.save(r, accountId);
      }
    });
  }

  // --- opening (BRD 2.2.7); this side is A, the invite's owner is B ---

  async open(invite: Invite, o: OpenOptions): Promise<ChannelRecord> {
    const { wallet, keys, pool, p2p, repository } = this.deps;
    const account = o.accountId ?? wallet.activeAccount().id;
    const peerAmount = o.peerAmount ?? 0n;
    const window = await this.checkWindow(o.window ?? this.deps.window);
    this.checkToken(o.token);
    const closingFee = quotedFee(await o.relayer.info(), o.token);
    if (o.amount <= closingFee || o.amount > MAX_AMOUNT || peerAmount < 0n || peerAmount > MAX_AMOUNT) {
      throw new AppError(400, 'INVALID_AMOUNT', 'The contribution must be larger than the closing fee and fit in a note');
    }
    await pool.sync(account);
    if ((pool.balances(account).get(o.token) ?? 0n) < o.amount) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough shielded funds to fund this channel');

    const poolKeys = await keys.poolKeys(account);
    const { index, secrets } = await keys.newChannel(account, this.deps.chain.network.id);
    const pkA = channelPublicKeyOf(secrets.signingKey);
    const tagA = ownerTagOf(secrets.tagSecret);
    const shareA = randomFieldElement();
    const contribA = { amount: o.amount, salt: randomFieldElement() };
    const nonce0 = nonceStep();
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
    const encPubA = bytesToHex(poolKeys.encryption.publicKey);
    const open: OpenMessage = {
      type: 'open',
      channelId: id,
      token: o.token,
      amountA: o.amount,
      amountB: peerAmount,
      window,
      closingFee,
      nonce0,
      shareA,
      pkA,
      tagA,
      encPubA,
      contribA,
      // B answers and later pays through these, so A must hold a relay reservation first.
      addrsA: await p2p.waitForRelay(),
    };
    const reply = parseReply(OpenReplySchema, await p2p.request(invite, open));
    if (reply.contribB ? reply.contribB.amount !== peerAmount : peerAmount !== 0n) throw new AppError(502, 'BAD_REPLY', 'The other party answered with a different contribution');

    const params = { pkA, pkB: reply.pkB, channelSecret: hash2(shareA, reply.shareB), window };
    const cA = noteCommitment(contributionNote(params, o.token, contribA, tagA));
    const terms = { amountA: o.amount, tagA, tagB: reply.tagB, closingFee };
    const s0 = openingState({ ...terms, contribs: [cA, 0n], amountB: 0n, nonce: nonce0 });
    const record: ChannelRecord = {
      id,
      role: 'A',
      index,
      peer: { peerId: invite.peerId, addrs: invite.addrs },
      token: o.token,
      status: 'opening',
      params,
      encPubA,
      encPubB: reply.encPubB,
      contribA,
      contribB: reply.contribB,
      state0: { state: s0, sigA: null, sigB: reply.sigB0 },
      latest: { state: s0, sigA: null, sigB: reply.sigB0 },
      pending: null,
      history: [],
      closeTx: null,
      createdAt: Date.now(),
    };
    if (!signedBy(record, 1, s0, reply.sigB0)) throw new AppError(502, 'BAD_SIGNATURE', 'The other party did not sign state 0');
    const sigA0 = signStateHash(secrets.signingKey, hashOf(record, s0));
    record.state0.sigA = sigA0;
    record.latest.sigA = sigA0;
    if (reply.contribB) {
      const cB = noteCommitment(contributionNote(params, o.token, reply.contribB, reply.tagB));
      const s1 = openingState({ ...terms, contribs: [cA, cB], amountB: peerAmount, nonce: nonce0 + nonceStep() });
      record.pending = { prevHash: hashOf(record, s0), state: s1, sig: signStateHash(secrets.signingKey, hashOf(record, s1)) };
    }
    await repository.save(record, account);
    o.onAccepted?.(id);

    // A funds only now that she holds state 0 signed by both sides, and signs state 1 after funding.
    const [noteA] = contributionsOf(record);
    await pool.spend({ token: o.token, payment: { note: noteA, encryptTo: poolKeys.encryption.publicKey }, publicAmount: 0n, recipient: zeroAddress, relayer: o.relayer, accountId: account });
    // If B is unreachable right now the channel stays "opening" and tick() sends the confirmation later.
    await this.confirmOpening(id, account).catch(() => undefined);
    return this.get(id, account);
  }

  /** A, once funded: sends B the signature of state 0 and the signed state 1, and gets B's signature of state 1. */
  private async confirmOpening(id: string, account: string): Promise<void> {
    const r = this.get(id, account);
    const message: ConfirmMessage = { type: 'confirm', channelId: id, sigA0: r.state0.sigA as StateSignature, state1: r.pending?.state ?? null, sigA1: r.pending?.sig ?? null };
    const reply = parseReply(ConfirmReplySchema, await this.deps.p2p.request(r.peer, message));
    await this.update(
      id,
      async (r) => {
        if (r.status !== 'opening') return;
        if (r.pending) {
          if (!reply.sigB1 || !signedBy(r, 1, r.pending.state, reply.sigB1)) throw new AppError(502, 'BAD_SIGNATURE', 'The other party did not sign state 1');
          this.promote(r, r.pending.state, r.pending.sig, reply.sigB1);
        }
        r.status = 'funding';
      },
      account,
    );
  }

  // --- cancelling an opening nobody funded (BRD 2.2.7) ---

  /** Whether the opener's contribution is in the pool, as of the last sync. */
  openerFunded(id: string, accountId?: string): boolean {
    return this.deps.pool.hasCommitment(contributionCommitments(this.get(id, accountId))[0]);
  }

  /**
   * Whether this side may cancel the opening: nobody's money is in the channel yet. The invitee
   * also waits a while first, so that it never cancels a channel the opener is still funding.
   */
  canCancel(id: string, accountId?: string): boolean {
    return this.cancelProblem(this.get(id, accountId)) === null;
  }

  /** Cancels an opening nobody funded and tells the other side, when it can be reached. */
  async cancel(id: string, accountId?: string): Promise<ChannelRecord> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    await this.deps.pool.refreshChain();
    const r = await this.update(
      id,
      async (r) => {
        const problem = this.cancelProblem(r);
        if (problem) throw new AppError(409, 'NOT_CANCELLABLE', problem);
        r.status = 'cancelled';
        return r;
      },
      account,
    );
    await this.deps.p2p.request(r.peer, { type: 'cancel', channelId: id }).catch(() => undefined);
    return this.get(id, account);
  }

  private cancelProblem(r: ChannelRecord): string | null {
    if (r.status !== 'opening') return 'Only a channel that is still opening can be cancelled';
    if (this.deps.pool.hasCommitment(contributionCommitments(r)[0])) return 'The opener’s contribution is already in the pool, so the channel goes on';
    if (r.role === 'B' && Date.now() - (r.createdAt ?? 0) < INVITEE_CANCEL_AFTER_MS) return 'The other side may still be funding it; it can be cancelled ten minutes after it was accepted';
    return null;
  }

  /** The other side cancelled an opening nobody funded. */
  private async onCancel(r: ChannelRecord): Promise<unknown> {
    if (r.status === 'cancelled') return {};
    await this.deps.pool.refreshChain();
    if (r.status !== 'opening' || this.deps.pool.hasCommitment(contributionCommitments(r)[0])) throw new AppError(409, 'NOT_CANCELLABLE', 'This channel can no longer be cancelled');
    r.status = 'cancelled';
    return {};
  }

  // --- payments (BRD 2.2.8) ---

  async pay(id: string, amount: bigint, accountId?: string): Promise<ChannelRecord> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    if (amount <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be positive');
    const { token } = this.get(id, account);
    if (this.deps.confirmPayment && !(await this.deps.confirmPayment({ channelId: id, token, amount }))) {
      throw new AppError(403, 'PAYMENT_DECLINED', 'The payment was not confirmed');
    }
    return this.propose(
      id,
      (r) => {
        const s = r.latest.state;
        const me = sideOf(r);
        if (balanceOf(s, me) < amount) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough balance in this channel');
        const sign = me === 0 ? -1n : 1n;
        return { ...s, balA: s.balA + sign * amount, balB: s.balB - sign * amount, nonce: s.nonce + nonceStep(), final: false };
      },
      account,
    );
  }

  // --- cooperative close (BRD 2.2.9) ---

  /**
   * Agrees a final state with the relayer's current fee as the closing fee (this side absorbs any
   * change), then submits the close. Also completes a close the other side agreed but never submitted.
   */
  async close(id: string, relayer: RelayerPort, accountId?: string): Promise<ChannelRecord> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const { token, latest } = this.get(id, account);
    if (!latest.state.final) {
      const fee = quotedFee(await relayer.info(), token);
      await this.propose(
        id,
        (r) => {
          const s = r.latest.state;
          const me = sideOf(r);
          const mine = balanceOf(s, me) + s.closingFee - fee;
          if (mine < 0n) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'This side’s balance cannot cover the closing fee');
          return { ...s, balA: me === 0 ? mine : s.balA, balB: me === 1 ? mine : s.balB, closingFee: fee, nonce: s.nonce + nonceStep(), final: true };
        },
        account,
      );
    }
    await this.update(
      id,
      async (r) => {
        if (r.status !== 'closing') throw new AppError(409, 'NOT_CLOSING', 'The channel is not closing');
        await this.submitClose(r, relayer, account);
      },
      account,
    );
    return this.get(id, account);
  }

  private async submitClose(r: ChannelRecord, relayer: RelayerPort, account: string): Promise<void> {
    const { pool, prover } = this.deps;
    const { state: s, sigA, sigB } = r.latest;
    if (!sigA || !sigB) throw new AppError(409, 'NOT_CLOSING', 'The final state is not signed by both sides');
    await pool.refreshChain();
    if (!(await this.settledOnChain(r))) {
      const info = await relayer.info();
      const { inputs, outputs, ciphertexts } = settlement(r, s, (c) => pool.proofOf(c), decodeShieldedAddress(info.shieldedAddress));
      const witness = transferWitness({
        root: pool.root,
        token: r.token,
        inputs,
        outputs,
        publicAmount: 0n,
        extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts }),
        channel: { params: r.params, state: s, sigA, sigB },
      });
      const { proof, signals } = await prover.prove('transfer', witness.input);
      const { txHash } = await relayer.submit({ kind: 'transact', proof: proof.map(String), signals: signals.map(String), recipient: zeroAddress, ciphertexts: concatHex(ciphertexts) });
      r.closeTx = txHash;
    }
    if (r.status === 'closing') await this.closed(r, account);
  }

  /**
   * Whether the channel's contributions are already spent. A spend through a dispute marks the
   * channel "disputing", for the dispute service to settle.
   */
  private async settledOnChain(r: ChannelRecord): Promise<boolean> {
    const [cA] = contributionCommitments(r);
    if (!this.deps.pool.isSpent(nullifierOf(r.params.channelSecret, cA))) return false;
    if (await this.deps.chain.isFinalized(channelNullifierOf(r.params.channelSecret))) r.status = 'disputing';
    return true;
  }

  /** Records a cooperative close and adds this side's payout to its notes. */
  private async closed(r: ChannelRecord, account: string): Promise<void> {
    r.status = 'closed';
    await this.deps.pool.sync(account);
    await this.deps.pool.adopt(payoutNote(r, r.latest.state, sideOf(r)), { channel: r.index }, account);
  }

  // --- background progress ---

  /**
   * Moves every channel forward (call it periodically): retries A's confirmation, makes B fund
   * once A's contribution is in the pool, marks channels live once both contributions are in, and
   * notices closes the other side submitted. Returns the channels it could not move.
   */
  async tick(relayer: RelayerPort, accountId?: string): Promise<TickProblem[]> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const { pool } = this.deps;
    const problems: TickProblem[] = [];
    await pool.refreshChain();
    for (const { id, status, role } of this.list(account)) {
      try {
        if (status === 'opening' && role === 'A') {
          if (pool.hasCommitment(contributionCommitments(this.get(id, account))[0])) await this.confirmOpening(id, account);
        } else if (status === 'cancelled' && role === 'A') {
          // A funding still on its way when the opening was cancelled: the money is in the channel, so it goes on.
          if (pool.hasCommitment(contributionCommitments(this.get(id, account))[0])) await this.update(id, async (r) => void (r.status = 'opening'), account);
        } else if (status === 'funding') {
          await this.update(id, (r) => this.advanceFunding(r, relayer, account), account);
        } else if (status === 'live' || status === 'closing') {
          await this.update(
            id,
            async (r) => {
              if ((await this.settledOnChain(r)) && r.status !== 'disputing') {
                if (r.latest.state.final) await this.closed(r, account);
                else r.status = 'disputing';
              }
            },
            account,
          );
        }
      } catch (error) {
        problems.push({ channelId: id, error });
      }
    }
    return problems;
  }

  private async advanceFunding(r: ChannelRecord, relayer: RelayerPort, account: string): Promise<void> {
    const { pool, keys } = this.deps;
    const [cA, cB] = contributionCommitments(r);
    const [, noteB] = contributionsOf(r);
    // B funds only after A's contribution is in the pool: otherwise no state could ever be disputed
    // (each lists A's contribution) and B's contribution could not be recovered.
    if (r.role === 'B' && noteB && pool.hasCommitment(cA) && !pool.hasCommitment(cB)) {
      const own = (await keys.poolKeys(account)).encryption.publicKey;
      await pool.spend({ token: r.token, payment: { note: noteB, encryptTo: own }, publicAmount: 0n, recipient: zeroAddress, relayer, accountId: account });
    }
    await this.refreshLive(r);
  }

  private async refreshLive(r: ChannelRecord): Promise<void> {
    const { pool } = this.deps;
    await pool.refreshChain();
    const [cA, cB] = contributionCommitments(r);
    if (r.status === 'funding' && pool.hasCommitment(cA) && (cB === 0n || pool.hasCommitment(cB))) r.status = 'live';
  }

  // --- messages from the peer ---

  async handle(fromPeerId: string, message: unknown): Promise<unknown> {
    const parsed = ChannelMessageSchema.safeParse(message);
    if (!parsed.success) throw new AppError(400, 'BAD_MESSAGE', 'Malformed channel message');
    const m = parsed.data;
    const account = this.deps.wallet.activeAccount().id;
    if (m.type === 'open') return this.locked(m.channelId, () => this.onOpen(fromPeerId, m, account));
    return this.locked(m.channelId, async () => {
      const r = this.deps.repository.get(m.channelId, account);
      if (!r || r.peer.peerId !== fromPeerId) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'No such channel with this peer');
      try {
        if (m.type === 'cancel') return await this.onCancel(r);
        return m.type === 'confirm' ? await this.onConfirm(r, m, account) : await this.onPropose(r, m, account);
      } finally {
        await this.deps.repository.save(r, account);
      }
    });
  }

  /** B: checks the proposed channel, joins it with fresh keys and signs state 0. */
  private async onOpen(from: string, m: OpenMessage, account: string): Promise<unknown> {
    const { keys, pool, repository, approveOpen } = this.deps;
    if (repository.get(m.channelId, account)) throw new AppError(409, 'CHANNEL_EXISTS', 'This channel already exists');
    await this.checkWindow(m.window);
    this.checkToken(m.token);
    if (m.contribA.amount !== m.amountA || m.amountA <= m.closingFee || m.amountA > MAX_AMOUNT || m.amountB > MAX_AMOUNT) {
      throw new AppError(400, 'INVALID_AMOUNT', 'The proposed amounts are not valid');
    }
    if ([m.shareA, m.tagA, m.contribA.salt, ...m.pkA].some((v) => v >= FIELD_SIZE) || m.nonce0 >= MAX_NONCE) throw new AppError(400, 'BAD_MESSAGE', 'Malformed channel message');
    const addrs = m.addrsA.filter((a) => a.endsWith(`/p2p/${from}`));
    if (addrs.length === 0) throw new AppError(400, 'BAD_MESSAGE', 'The opener sent no address to reach it');
    const request: OpenRequest = { channelId: m.channelId, peerId: from, token: m.token, amount: m.amountA, peerAmount: m.amountB, window: m.window, closingFee: m.closingFee };
    const approved = approveOpen ? await approveOpen(request) : m.amountB === 0n;
    if (!approved) throw new AppError(403, 'OPEN_DECLINED', 'The other party declined this channel');
    if (m.amountB > 0n) {
      await pool.sync(account);
      if ((pool.balances(account).get(m.token) ?? 0n) < m.amountB) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'The other party cannot fund its side');
    }

    const poolKeys = await keys.poolKeys(account);
    const { index, secrets } = await keys.newChannel(account, this.deps.chain.network.id);
    const pkB = channelPublicKeyOf(secrets.signingKey);
    const tagB = ownerTagOf(secrets.tagSecret);
    const shareB = randomFieldElement();
    const params = { pkA: m.pkA, pkB, channelSecret: hash2(m.shareA, shareB), window: m.window };
    const contribB = m.amountB > 0n ? { amount: m.amountB, salt: randomFieldElement() } : null;
    const cA = noteCommitment(contributionNote(params, m.token, m.contribA, m.tagA));
    const s0 = openingState({ contribs: [cA, 0n], amountA: m.amountA, amountB: 0n, tagA: m.tagA, tagB, closingFee: m.closingFee, nonce: m.nonce0 });
    const record: ChannelRecord = {
      id: m.channelId,
      role: 'B',
      index,
      peer: { peerId: from, addrs },
      token: m.token,
      status: 'opening',
      params,
      encPubA: m.encPubA,
      encPubB: bytesToHex(poolKeys.encryption.publicKey),
      contribA: m.contribA,
      contribB,
      state0: { state: s0, sigA: null, sigB: null },
      latest: { state: s0, sigA: null, sigB: null },
      pending: null,
      history: [],
      closeTx: null,
      createdAt: Date.now(),
    };
    const sigB0 = signStateHash(secrets.signingKey, hashOf(record, s0));
    record.state0.sigB = sigB0;
    record.latest.sigB = sigB0;
    await repository.save(record, account);
    this.deps.onJoined?.(m.channelId);
    return { shareB, pkB, tagB, encPubB: record.encPubB, contribB, sigB0 };
  }

  /** B: receives A's signature of state 0 and the signed state 1 (B funds later, from tick()). */
  private async onConfirm(r: ChannelRecord, m: ConfirmMessage, account: string): Promise<unknown> {
    if (r.role !== 'B') throw new AppError(400, 'BAD_MESSAGE', 'Unexpected confirmation');
    if (r.status === 'cancelled') throw new AppError(409, 'CANCELLED', 'This channel was cancelled');
    const [cA, cB] = contributionCommitments(r);
    let state1: ChannelState | null = null;
    if (r.contribB) {
      if (!m.state1 || !m.sigA1) throw new AppError(400, 'BAD_MESSAGE', 'State 1 is missing');
      const s0 = r.state0.state;
      const expected = openingState({ contribs: [cA, cB], amountA: r.contribA.amount, amountB: r.contribB.amount, tagA: s0.payoutA, tagB: s0.payoutB, closingFee: s0.closingFee, nonce: m.state1.nonce });
      if (hashOf(r, expected) !== hashOf(r, m.state1) || m.state1.nonce <= s0.nonce || m.state1.nonce > MAX_NONCE) throw new AppError(409, 'PROPOSAL_REFUSED', 'State 1 does not match the agreed terms');
      if (!signedBy(r, 0, m.state1, m.sigA1)) throw new AppError(400, 'BAD_SIGNATURE', 'Bad signature of state 1');
      state1 = m.state1;
    } else if (m.state1) {
      throw new AppError(400, 'BAD_MESSAGE', 'No state 1 without a second contribution');
    }
    if (r.status !== 'opening') {
      // A repeated confirmation whose answer was lost: answer it again (signatures are deterministic).
      const first = r.history[0];
      if (!state1) return { sigB1: null };
      if (first && hashOf(r, state1) === hashOf(r, stateFromEntry(r, first))) return { sigB1: await this.sign(r, state1, account) };
      throw new AppError(409, 'STALE_STATE', 'The channel is already confirmed');
    }
    if (!signedBy(r, 0, r.state0.state, m.sigA0)) throw new AppError(400, 'BAD_SIGNATURE', 'Bad signature of state 0');
    r.state0.sigA = m.sigA0;
    r.latest = { ...r.state0 };
    let sigB1: StateSignature | null = null;
    if (state1 && m.sigA1) {
      sigB1 = await this.sign(r, state1, account);
      this.promote(r, state1, sigB1, m.sigA1);
    }
    r.status = 'funding';
    return { sigB1 };
  }

  /** Countersigns the peer's proposal if it does not lower this side's balance (BRD 2.2.8). */
  private async onPropose(r: ChannelRecord, m: ProposeMessage, account: string): Promise<unknown> {
    const me = sideOf(r);
    const peer: Side = me === 0 ? 1 : 0;
    if (!signedBy(r, peer, m.state, m.sig)) throw new AppError(400, 'BAD_SIGNATURE', 'Bad signature of the proposed state');
    // Asked again after our answer was lost: we already countersigned exactly this state.
    if (hashOf(r, m.state) === hashOf(r, r.latest.state)) return { sig: this.ownSignature(r.latest, me) };
    // The peer countersigned our proposal but its answer never reached us: its signature completes it.
    if (r.pending && m.prevHash === hashOf(r, r.pending.state) && signedBy(r, peer, r.pending.state, m.prevSig)) {
      this.promote(r, r.pending.state, r.pending.sig, m.prevSig);
    }
    if (m.prevHash !== hashOf(r, r.latest.state)) throw new AppError(409, 'STALE_STATE', 'The proposal builds on a state this side does not hold');
    if (r.status === 'funding') await this.refreshLive(r);
    if (r.status !== 'live') throw new AppError(409, 'NOT_LIVE', 'The channel is not live');
    if (r.pending && r.pending.prevHash === m.prevHash) {
      const mine = { nonce: r.pending.state.nonce, proposer: publicKeyOf(r, me) };
      if (winsTieBreak(mine, { nonce: m.state.nonce, proposer: publicKeyOf(r, peer) })) {
        throw new AppError(409, 'CONFLICT', 'A rival proposal on the same state wins the tie-break');
      }
      r.pending = null; // ours loses: countersign theirs; our payment is proposed again on top of it
    }
    const problem = successorProblem(r.latest.state, m.state, m.type, me);
    if (problem) throw new AppError(409, 'PROPOSAL_REFUSED', problem);
    const sig = await this.sign(r, m.state, account);
    this.promote(r, m.state, sig, m.sig);
    return { sig };
  }

  // --- proposing ---

  /**
   * Proposes the state `build` makes from the latest one and waits for the peer's signature. An
   * earlier proposal still unanswered is sent first. On losing a tie-break, waits for the winning
   * state and proposes again on top of it.
   */
  private async propose(id: string, build: (r: ChannelRecord) => ChannelState, account: string): Promise<ChannelRecord> {
    let target: { hash: bigint; nonce: bigint } | null = null;
    for (let attempt = 0; attempt < PROPOSE_ATTEMPTS; ) {
      const step = await this.update(
        id,
        async (r) => {
          if (target && holdsState(r, target.hash, target.nonce)) return null;
          if (r.pending && r.pending.prevHash !== hashOf(r, r.latest.state)) r.pending = null; // superseded
          if (!r.pending) {
            if (r.status === 'funding') await this.refreshLive(r);
            if (r.status !== 'live') throw new AppError(409, 'NOT_LIVE', 'The channel is not live');
            const state = build(r);
            r.pending = { prevHash: hashOf(r, r.latest.state), state, sig: await this.sign(r, state, account) };
            target = { hash: hashOf(r, state), nonce: state.nonce };
          }
          return { pending: r.pending, prevSig: this.ownSignature(r.latest, sideOf(r)), peer: r.peer };
        },
        account,
      );
      if (!step) return this.get(id, account);
      const { pending, prevSig, peer } = step;
      const message: ProposeMessage = { type: pending.state.final ? 'close' : 'pay', channelId: id, prevHash: pending.prevHash, state: pending.state, sig: pending.sig, prevSig };
      let reply: { sig: StateSignature };
      try {
        reply = parseReply(ProposeReplySchema, await this.deps.p2p.request(peer, message));
      } catch (err) {
        // Lost a tie-break: once the winning state is ours too, propose again on top of it. A
        // losing proposal can also reach the winner after its own state completed (STALE_STATE).
        if (isAppError(err) && (err.code === 'CONFLICT' || err.code === 'STALE_STATE')) {
          if (err.code === 'CONFLICT') await this.waitForChange(id, pending.prevHash, account);
          const r = this.get(id, account);
          if (err.code === 'CONFLICT' || hashOf(r, r.latest.state) !== pending.prevHash) {
            attempt++;
            continue;
          }
        }
        if (isAppError(err) && FINAL_REFUSALS.has(err.code)) {
          await this.update(
            id,
            async (r) => {
              if (r.pending && hashOf(r, r.pending.state) === hashOf(r, pending.state)) r.pending = null;
            },
            account,
          );
        }
        throw err;
      }
      await this.update(
        id,
        async (r) => {
          const peerSide: Side = sideOf(r) === 0 ? 1 : 0;
          if (!signedBy(r, peerSide, pending.state, reply.sig)) throw new AppError(502, 'BAD_SIGNATURE', 'The other party’s signature is not valid');
          if (r.pending && hashOf(r, r.pending.state) === hashOf(r, pending.state)) this.promote(r, pending.state, pending.sig, reply.sig);
        },
        account,
      );
    }
    throw new AppError(409, 'CONFLICT', 'The other party kept proposing at the same time; try again');
  }

  private async waitForChange(id: string, prevHash: bigint, account: string): Promise<void> {
    const deadline = Date.now() + CONFLICT_WAIT_MS;
    while (Date.now() < deadline) {
      const r = this.get(id, account);
      if (hashOf(r, r.latest.state) !== prevHash) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // --- helpers ---

  /** Makes a fully signed state the latest one. */
  private promote(r: ChannelRecord, state: ChannelState, mine: StateSignature, theirs: StateSignature): void {
    const me = sideOf(r);
    r.latest = { state, sigA: me === 0 ? mine : theirs, sigB: me === 1 ? mine : theirs };
    r.history.push(historyEntry(state));
    if (r.pending && hashOf(r, r.pending.state) === hashOf(r, state)) r.pending = null;
    if (state.final) r.status = 'closing';
  }

  private ownSignature(signed: Signed, side: Side): StateSignature {
    const sig = side === 0 ? signed.sigA : signed.sigB;
    if (!sig) throw new AppError(409, 'NOT_SIGNED', 'This side has not signed the latest state');
    return sig;
  }

  private async sign(r: ChannelRecord, s: ChannelState, account: string): Promise<StateSignature> {
    return signStateHash(channelSecrets(await this.deps.keys.poolKeys(account), r.index).signingKey, hashOf(r, s));
  }

  private async checkWindow(window: bigint | undefined): Promise<bigint> {
    const { min, max } = await this.deps.chain.windowBounds();
    const value = window ?? max;
    if (value < min || value > max) throw new AppError(400, 'INVALID_WINDOW', `The dispute window must be between ${min} and ${max} seconds`);
    return value;
  }

  private checkToken(token: bigint): void {
    if (token !== 0n && token !== BigInt(this.deps.chain.network.usdg)) throw new AppError(400, 'TOKEN_NOT_SUPPORTED', 'Channels hold ETH or USDG');
  }

  private locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).then(run);
    this.locks.set(
      id,
      result.catch(() => undefined),
    );
    return result;
  }
}

function parseReply<T extends z.ZodType>(schema: T, reply: unknown): z.output<T> {
  const parsed = schema.safeParse(reply);
  if (!parsed.success) throw new AppError(502, 'BAD_REPLY', 'The other party sent a malformed answer');
  return parsed.data;
}
