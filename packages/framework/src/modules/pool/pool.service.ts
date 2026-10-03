import { bytesToHex, concatHex, hexToBytes, zeroAddress, type Address, type Hex } from 'viem';
import { AppError } from '../../shared/errors/AppError.ts';
import type { ProverPort } from '../../shared/integrations/prover.ts';
import {
  MerkleTree,
  decryptNote,
  dummyInput,
  encryptNote,
  extDataHashOf,
  noteCommitment,
  noteInner,
  nullifierOf,
  randomFieldElement,
  transferWitness,
  type NotePreimage,
  type SpendInput,
} from '../../shared/protocol/index.ts';
import { tokenAddress, type ChainAdapter, type CommitmentEvent } from '../chain/index.ts';
import { channelSecrets, decodeShieldedAddress, type KeyRing, type PoolKeys } from '../keys/index.ts';
import type { RelayerPort } from '../relayer/index.ts';
import type { WalletService } from '../wallet/index.ts';
import type { PoolRepository } from './pool.repository.ts';
import type { StoredNote } from './pool.schema.ts';

/** How many merges a payment may need before giving up (each merge is one relayed transfer). */
const MAX_MERGES = 20;

export interface PoolDeps {
  wallet: WalletService;
  keys: KeyRing;
  chain: ChainAdapter;
  prover: ProverPort;
  repository: PoolRepository;
}

/** A note the account can spend, with the secret that unlocks it. */
export interface SpendableNote extends StoredNote {
  unlockSecret: bigint;
}

/**
 * The shielded pool for one network (BRD 2.2.1–2.2.5): mirrors the pool's tree and nullifiers,
 * finds the account's notes by trial decryption, and builds deposits, private transfers and
 * withdrawals. Every transaction except a deposit goes through a relayer and pays it with a fee note.
 */
export class PoolService {
  private readonly deps: PoolDeps;
  private tree = new MerkleTree();
  private events: CommitmentEvent[] = [];
  private nullifiers = new Set<bigint>();
  private scannedTo = -1n;
  /** Spends run one after another: two at once could pick the same notes. */
  private spending: Promise<unknown> = Promise.resolve();

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  /** Mirrors the on-chain tree and spent nullifiers up to the latest block (downloads all events, BRD 2.2.4). */
  async refreshChain(): Promise<void> {
    const { chain } = this.deps;
    const { deployBlock } = chain.contracts();
    const from = this.scannedTo < deployBlock ? deployBlock : this.scannedTo + 1n;
    // One endpoint answers for the whole range, up to the latest block it has.
    const { toBlock: latest, commitments, nullifiers } = await chain.poolEvents(from);
    if (from > latest) return;
    for (const event of commitments) {
      if (event.leafIndex !== this.tree.size) {
        // A gap means the mirror is out of step (e.g. an RPC hiccup): rebuild it from scratch.
        this.tree = new MerkleTree();
        this.events = [];
        this.nullifiers = new Set();
        this.scannedTo = -1n;
        return this.refreshChain();
      }
      this.tree.insert(event.commitment);
      this.events.push(event);
    }
    for (const n of nullifiers) this.nullifiers.add(n);
    this.scannedTo = latest;
  }

  /** Current root of the mirrored tree. */
  get root(): bigint {
    return this.tree.root;
  }

  /** Merkle proof of a commitment in the mirrored tree. */
  proofOf(commitment: bigint) {
    const index = this.tree.indexOf(commitment);
    if (index < 0) throw new AppError(409, 'NOT_IN_POOL', 'This note is not in the pool yet');
    return this.tree.proof(index);
  }

  emptyProof() {
    return this.tree.emptyProof();
  }

  hasCommitment(commitment: bigint): boolean {
    return this.tree.indexOf(commitment) >= 0;
  }

  isSpent(nullifier: bigint): boolean {
    return this.nullifiers.has(nullifier);
  }

  /** Trial-decrypts every new pool event for the account and marks its spent notes. */
  async sync(accountId?: string): Promise<void> {
    const { keys: keyring, repository } = this.deps;
    // Fixed once: the user may switch account while the sync runs.
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    await this.refreshChain();
    const keys = await keyring.poolKeys(account);
    const channelTags = await keyring.channelTags(account, this.deps.chain.network.id);
    const section = repository.load(account);
    const known = new Set(section.notes.map((n) => n.commitment));
    for (const event of this.events) {
      if (event.blockNumber <= section.syncedBlock || known.has(event.commitment)) continue;
      const note = decryptNote(keys.encryption, hexToBytes(event.ciphertext));
      if (!note || note.amount === 0n || !matches(note, event.commitment)) continue;
      const secret = note.ownerTag === keys.ownerTag ? 'spending' : channelTags.has(note.ownerTag) ? { channel: channelTags.get(note.ownerTag) as number } : null;
      if (!secret) continue; // e.g. our own channel contribution: tracked by the channel module
      section.notes.push({ ...note, commitment: event.commitment, leafIndex: event.leafIndex, secret, spent: false });
      known.add(event.commitment);
    }
    this.markSpent(section.notes, keys);
    section.syncedBlock = this.scannedTo;
    await repository.save(section, account);
  }

  /**
   * Records a note the account can rebuild without decrypting anything, such as a channel payout
   * whose salt comes from the state (BRD 2.2.9), once it is in the pool.
   */
  async adopt(note: NotePreimage, secret: StoredNote['secret'], accountId?: string): Promise<boolean> {
    const account = accountId ?? this.deps.wallet.activeAccount().id;
    const commitment = noteCommitment(note);
    if (note.amount === 0n || !this.hasCommitment(commitment)) return false;
    const keys = await this.deps.keys.poolKeys(account);
    const section = this.deps.repository.load(account);
    if (section.notes.some((n) => n.commitment === commitment)) return true;
    section.notes.push({ ...note, commitment, leafIndex: this.tree.indexOf(commitment), secret, spent: false });
    this.markSpent(section.notes, keys);
    await this.deps.repository.save(section, account);
    return true;
  }

  notes(accountId?: string): StoredNote[] {
    return this.deps.repository.load(accountId).notes;
  }

  /** Shielded balance per token (token address as number, 0 = ETH). */
  balances(accountId?: string): Map<bigint, bigint> {
    const out = new Map<bigint, bigint>();
    for (const n of this.notes(accountId)) if (!n.spent) out.set(n.token, (out.get(n.token) ?? 0n) + n.amount);
    return out;
  }

  // --- deposit (BRD 2.2.2) ---

  async deposit(token: bigint, amount: bigint, accountId?: string): Promise<Hex> {
    const { wallet, keys: keyring, chain } = this.deps;
    const account = accountId ?? wallet.activeAccount().id;
    const keys = await keyring.poolKeys(account);
    const note: NotePreimage = { amount, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    const ciphertext = bytesToHex(encryptNote(keys.encryption.publicKey, note));
    const txHash = await chain.deposit(wallet.signer(account), token, amount, noteInner(note.ownerTag, note.salt), ciphertext);
    await wallet.markUsed(account);
    await this.sync(account);
    return txHash;
  }

  // --- private transfer and withdrawal (BRD 2.2.3, 2.2.5) ---

  /** Pays `amount` of `token` to a shielded address inside the pool. */
  async transfer(to: string, token: bigint, amount: bigint, relayer: RelayerPort, accountId?: string): Promise<Hex> {
    const payee = decodeShieldedAddress(to);
    const payment: NotePreimage = { amount, token, ownerTag: payee.ownerTag, salt: randomFieldElement() };
    return this.spend({ token, payment: { note: payment, encryptTo: payee.encryptionPublicKey }, publicAmount: 0n, recipient: zeroAddress, relayer, accountId });
  }

  /** Takes `amount` of `token` out of the pool to `recipient` (ideally a fresh address). */
  async withdraw(token: bigint, amount: bigint, recipient: Address, relayer: RelayerPort, accountId?: string): Promise<Hex> {
    if (amount <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be positive');
    return this.spend({ token, publicAmount: amount, recipient, relayer, accountId });
  }

  /** Builds, proves and relays one transfer whose outputs are [payment or change, change or empty, fee note]. */
  spend(args: SpendArgs): Promise<Hex> {
    const run = this.spending.then(() => this.spendNow(args));
    this.spending = run.catch(() => undefined);
    return run;
  }

  private async spendNow(args: SpendArgs): Promise<Hex> {
    const { token, payment, publicAmount, recipient, relayer } = args;
    const accountId = args.accountId ?? this.deps.wallet.activeAccount().id;
    await this.sync(accountId);
    const keys = await this.deps.keys.poolKeys(accountId);
    const info = await relayer.info();
    const fee = BigInt(info.fees[tokenAddress(token).toLowerCase()] ?? Number.NaN);
    const relayerAddress = decodeShieldedAddress(info.shieldedAddress);
    const need = (payment?.note.amount ?? 0n) + publicAmount + fee;

    let inputs = selectInputs(await this.spendable(token, accountId), need);
    for (let merges = 0; inputs === 'fragmented'; merges++) {
      if (merges === MAX_MERGES) throw new AppError(409, 'NOTES_FRAGMENTED', 'Too many small notes to cover this amount');
      await this.mergeTwoLargest(token, fee, relayer, keys, accountId);
      inputs = selectInputs(await this.spendable(token, accountId), need);
    }
    if (inputs === 'insufficient') throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Not enough shielded funds in this token (including the relayer fee)');

    const total = inputs.reduce((s, n) => s + n.amount, 0n);
    const change: NotePreimage = { amount: total - need, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    const empty: NotePreimage = { amount: 0n, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    const feeNote: NotePreimage = { amount: fee, token, ownerTag: relayerAddress.ownerTag, salt: randomFieldElement() };
    const outputs: [NotePreimage, NotePreimage, NotePreimage] = payment ? [payment.note, change, feeNote] : [change, empty, feeNote];
    const ciphertexts = [
      bytesToHex(encryptNote(payment ? payment.encryptTo : keys.encryption.publicKey, outputs[0])),
      bytesToHex(encryptNote(keys.encryption.publicKey, outputs[1])),
      bytesToHex(encryptNote(relayerAddress.encryptionPublicKey, feeNote)),
    ] as [Hex, Hex, Hex];

    const spendInputs = inputs.map((n): SpendInput => ({ note: n, unlock: { kind: 'personal', secret: n.unlockSecret }, proof: this.tree.proof(n.leafIndex) }));
    const witness = transferWitness({
      root: this.tree.root,
      token,
      inputs: [spendInputs[0] as SpendInput, spendInputs[1] ?? dummyInput(token)],
      outputs,
      publicAmount,
      extDataHash: extDataHashOf({ recipient, ciphertexts }),
    });
    const { proof, signals } = await this.deps.prover.prove('transfer', witness.input);
    const { txHash } = await relayer.submit({
      kind: 'transact',
      proof: proof.map(String),
      signals: signals.map(String),
      recipient,
      ciphertexts: concatHex(ciphertexts),
    });
    await this.sync(accountId);
    return txHash;
  }

  /** Unspent notes of a token with the secret that unlocks each. */
  async spendable(token: bigint, accountId?: string): Promise<SpendableNote[]> {
    const keys = await this.deps.keys.poolKeys(accountId);
    return this.notes(accountId)
      .filter((n) => !n.spent && n.token === token)
      .map((n) => ({ ...n, unlockSecret: secretOf(n, keys) }));
  }

  private markSpent(notes: StoredNote[], keys: PoolKeys): void {
    for (const n of notes) if (!n.spent && this.nullifiers.has(nullifierOf(secretOf(n, keys), n.commitment))) n.spent = true;
  }

  /** Combines the two largest notes of a token into one (a private transfer to oneself). */
  private async mergeTwoLargest(token: bigint, fee: bigint, relayer: RelayerPort, keys: PoolKeys, accountId?: string): Promise<void> {
    const notes = (await this.spendable(token, accountId)).sort((a, b) => (a.amount > b.amount ? -1 : 1)).slice(0, 2);
    const total = notes.reduce((s, n) => s + n.amount, 0n);
    if (notes.length < 2 || total <= fee) throw new AppError(409, 'NOTES_FRAGMENTED', 'Too many small notes to cover this amount');
    const self: NotePreimage = { amount: total - fee, token, ownerTag: keys.ownerTag, salt: randomFieldElement() };
    await this.spendNow({ token, payment: { note: self, encryptTo: keys.encryption.publicKey }, publicAmount: 0n, recipient: zeroAddress, relayer, accountId });
  }
}

interface SpendArgs {
  token: bigint;
  payment?: { note: NotePreimage; encryptTo: Uint8Array };
  publicAmount: bigint;
  recipient: Address;
  relayer: RelayerPort;
  accountId?: string;
}

/** Picks one note, else the cheapest pair of notes, that covers `need` (transfers have two inputs). */
export function selectInputs(notes: readonly SpendableNote[], need: bigint): SpendableNote[] | 'fragmented' | 'insufficient' {
  const total = notes.reduce((s, n) => s + n.amount, 0n);
  if (total < need) return 'insufficient';
  const ascending = [...notes].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  const single = ascending.find((n) => n.amount >= need);
  if (single) return [single];
  let best: [SpendableNote, SpendableNote] | null = null;
  for (let i = 0; i < ascending.length; i++) {
    for (let j = i + 1; j < ascending.length; j++) {
      const a = ascending[i] as SpendableNote;
      const b = ascending[j] as SpendableNote;
      if (a.amount + b.amount >= need && (!best || a.amount + b.amount < best[0].amount + best[1].amount)) best = [a, b];
    }
  }
  return best ?? 'fragmented';
}

function secretOf(note: StoredNote, keys: PoolKeys): bigint {
  return note.secret === 'spending' ? keys.spendingSecret : channelSecrets(keys, note.secret.channel).tagSecret;
}

function matches(note: NotePreimage, commitment: bigint): boolean {
  try {
    return noteCommitment(note) === commitment;
  } catch {
    return false;
  }
}
