import {
  MerkleTree,
  TREE_DEPTH,
  channelPublicKeyOf,
  channelTagOf,
  extDataHashOf,
  generateChannelKey,
  noteCommitment,
  ownerTagOf,
  paramsHashOf,
  payoutSaltOf,
  randomFieldElement,
  signStateHash,
  stateHashOf,
  type ChannelParams,
  type ChannelState,
  type NotePreimage,
  type SignedState,
  type SpendInput,
} from '@occulta/framework/protocol';
import { zeroAddress } from 'viem';

// Test fixtures shared by the circuit tests: people, notes in a tree, and a channel with signed states.

export const ETH = 0n;
export const USDG = 0x004b506865409877c9fa29bfb1eba929984b9bbcn;
export const EXT = extDataHashOf({ recipient: zeroAddress, ciphertexts: ['0x01', '0x02', '0x03'] });

export interface Person {
  secret: bigint;
  ownerTag: bigint;
}

export function person(): Person {
  const secret = randomFieldElement();
  return { secret, ownerTag: ownerTagOf(secret) };
}

export function note(amount: bigint, token: bigint, ownerTag: bigint, salt = randomFieldElement()): NotePreimage {
  return { amount, token, ownerTag, salt };
}

export class World {
  readonly tree = new MerkleTree(TREE_DEPTH);

  /** Adds a note to the tree (as a deposit or an earlier transfer would) and returns a spend for it. */
  addPersonal(n: NotePreimage, owner: Person): SpendInput {
    const leafIndex = this.tree.insert(noteCommitment(n));
    return { note: n, unlock: { kind: 'personal', secret: owner.secret }, proof: this.tree.proof(leafIndex) };
  }

  addContribution(n: NotePreimage, refundTag: bigint): SpendInput {
    const leafIndex = this.tree.insert(noteCommitment(n));
    return { note: n, unlock: { kind: 'channel', refundTag }, proof: this.tree.proof(leafIndex) };
  }

  /** Re-reads a spend's Merkle proof after later insertions changed the root. */
  refresh(spend: SpendInput): SpendInput {
    if (spend.note.amount === 0n) return spend;
    return { ...spend, proof: this.tree.proof(this.tree.indexOf(noteCommitment(spend.note))) };
  }
}

export class TestChannel {
  readonly keyA = generateChannelKey();
  readonly keyB = generateChannelKey();
  readonly params: ChannelParams;
  readonly paramsHash: bigint;
  /** Fresh per-channel secrets: their owner tags are the payout and refund tags. */
  readonly alice = person();
  readonly bob = person();

  constructor(window = 3n * 86_400n) {
    this.params = {
      pkA: channelPublicKeyOf(this.keyA),
      pkB: channelPublicKeyOf(this.keyB),
      channelSecret: randomFieldElement(),
      window,
    };
    this.paramsHash = paramsHashOf(this.params);
  }

  contributionNote(amount: bigint, token: bigint, side: 'A' | 'B'): NotePreimage {
    const refund = side === 'A' ? this.alice : this.bob;
    return note(amount, token, channelTagOf(this.paramsHash, refund.ownerTag));
  }

  state(fields: Partial<ChannelState> & Pick<ChannelState, 'contribs' | 'balA' | 'balB'>): ChannelState {
    return {
      payoutA: this.alice.ownerTag,
      payoutB: this.bob.ownerTag,
      closingFee: 0n,
      nonce: 1n,
      final: false,
      ...fields,
    };
  }

  sign(state: ChannelState, keys: { a?: Uint8Array; b?: Uint8Array } = {}): SignedState {
    const h = stateHashOf(this.paramsHash, state);
    return {
      params: this.params,
      state,
      sigA: signStateHash(keys.a ?? this.keyA, h),
      sigB: signStateHash(keys.b ?? this.keyB, h),
    };
  }

  /** The outputs a close must create for a state: both payouts and the fee note for a relayer. */
  closeOutputs(signed: SignedState, token: bigint, relayerTag: bigint): [NotePreimage, NotePreimage, NotePreimage] {
    const h = stateHashOf(this.paramsHash, signed.state);
    const s = signed.state;
    return [
      note(s.balA, token, s.payoutA, payoutSaltOf(this.params.channelSecret, h, 0)),
      note(s.balB, token, s.payoutB, payoutSaltOf(this.params.channelSecret, h, 1)),
      note(s.closingFee, token, relayerTag),
    ];
  }
}
