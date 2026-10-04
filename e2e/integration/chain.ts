// Helpers for integration tests against the local dev node.
import { join } from 'node:path';
import * as snarkjs from 'snarkjs';
import {
  BaseError,
  type Abi,
  ContractFunctionRevertedError,
  bytesToHex,
  hexToBytes,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  MerkleTree,
  encryptNote,
  encryptionPublicKeyOf,
  randomFieldElement,
  toEvmProof,
  type CircuitInput,
  type EvmProof,
  type NotePreimage,
} from '../../packages/framework/src/shared/protocol/index.ts';
import { poolAbi } from '../../packages/framework/src/modules/chain/chain.abi.ts';
import { REPO, devChain, devPublicClient, devWalletClient } from '../../scripts/lib/devnode.ts';
import { deployOcculta, type Deployment } from '../../scripts/lib/stylus.ts';
import { deployTestToken } from '../../scripts/lib/test-token.ts';

export const client: PublicClient = devPublicClient();
export const dev: WalletClient = devWalletClient();

export async function freshDeployment(): Promise<Deployment> {
  const usdg = await deployTestToken(dev, client);
  return deployOcculta(dev, client, usdg, { e2e: true });
}

/** A new account funded with ETH from the dev account. */
export async function fundedAccount(eth = '1'): Promise<WalletClient> {
  const key = generatePrivateKey();
  const hash = await dev.sendTransaction({ account: dev.account!, chain: devChain, to: privateKeyToAccount(key).address, value: parseEther(eth) });
  await client.waitForTransactionReceipt({ hash });
  return devWalletClient(key);
}

export function freshAddress(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

export interface EncryptionKeys {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function encryptionKeys(): EncryptionKeys {
  const privateKey = hexToBytes(generatePrivateKey());
  return { privateKey, publicKey: encryptionPublicKeyOf(privateKey) };
}

export const ciphertextFor = (keys: EncryptionKeys, note: NotePreimage): Hex => bytesToHex(encryptNote(keys.publicKey, note));

export function note(amount: bigint, token: bigint, ownerTag: bigint): NotePreimage {
  return { amount, token, ownerTag, salt: randomFieldElement() };
}

export async function prove(name: string, input: CircuitInput): Promise<{ proof: EvmProof; signals: bigint[] }> {
  const dir = join(REPO, 'packages/framework/artifacts');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, join(dir, `${name}.wasm`), join(dir, `${name}.zkey`));
  return { proof: toEvmProof(proof), signals: publicSignals.map(BigInt) };
}

/** Rebuilds the pool's tree from its NewCommitment events, as a wallet does. */
export async function mirrorTree(pool: Address, fromBlock: bigint): Promise<MerkleTree> {
  const logs = await client.getContractEvents({ address: pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock });
  const tree = new MerkleTree();
  for (const log of logs.sort((a, b) => Number(a.args.leafIndex! - b.args.leafIndex!))) tree.insert(log.args.commitment!);
  return tree;
}

/**
 * The dev node only produces blocks for transactions, so the latest block's timestamp (which gas
 * estimation runs against) stands still while nothing happens. Mining an empty transfer brings it
 * up to the wall clock, as on a live chain.
 */
export async function mineBlock(): Promise<void> {
  const hash = await dev.sendTransaction({ account: dev.account!, chain: devChain, to: dev.account!.address, value: 0n });
  await client.waitForTransactionReceipt({ hash });
}

export interface WriteRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/** Sends a contract write and returns the receipt; throws on revert. */
export async function send(wallet: WalletClient, request: WriteRequest) {
  const hash = await wallet.writeContract({ ...request, account: wallet.account!, chain: devChain } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('transaction reverted');
  return receipt;
}

/** Name of the custom error a simulated call reverts with. */
export async function revertName(simulation: Promise<unknown>): Promise<string> {
  try {
    await simulation;
  } catch (err) {
    if (err instanceof BaseError) {
      const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.shortMessage;
    }
    throw err;
  }
  throw new Error('expected the call to revert');
}

export const tuple = <T extends readonly bigint[]>(values: readonly bigint[]): T => values as unknown as T;
