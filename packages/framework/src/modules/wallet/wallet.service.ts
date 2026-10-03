import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex, isHex, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { DEFAULT_KDF, deriveVaultKey, open, seal, type KdfParams, type VaultKey } from './vault.ts';
import type { WalletRepository } from './wallet.repository.ts';
import type { Account, WalletDocument } from './wallet.schema.ts';

/** BRD 2.2.14.3: passwords shorter than this are rejected. */
export const MIN_PASSWORD_LENGTH = 8;
/** BRD 2.2.14.5: a new wallet starts on Arbitrum Sepolia. */
export const DEFAULT_NETWORK = 'arbitrum-sepolia';
/** BRD 2.2.14.1: the user re-enters this many words of a new phrase. */
export const CONFIRMATION_WORDS = 3;

const derivationPath = (index: number): string => `m/44'/60'/0'/0/${index}`;

function derivedKey(mnemonic: string, index: number): Hex {
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(derivationPath(index)).privateKey;
  if (!key) throw new AppError(500, 'DERIVATION_FAILED', 'Could not derive the account');
  return bytesToHex(key);
}

/**
 * The built-in wallet (BRD 2.2.14): recovery phrase or imported keys, several accounts, a password
 * that encrypts everything, and export/import of the whole wallet as one encrypted file.
 */
export class WalletService {
  private readonly repository: WalletRepository;
  private readonly kdf: KdfParams;
  private doc: WalletDocument | null = null;
  private vaultKey: VaultKey | null = null;

  /** `kdf` is only lowered by tests; real wallets use the default scrypt cost. */
  constructor(repository: WalletRepository, kdf: KdfParams = DEFAULT_KDF) {
    this.repository = repository;
    this.kdf = kdf;
  }

  // --- creating and importing (BRD 2.2.14.1) ---

  /** A fresh standard 12-word phrase; nothing is stored until the user confirms it. */
  generatePhrase(): string {
    return generateMnemonic(wordlist, 128);
  }

  /** Positions (0-based) of the words the user must re-enter, chosen by the wallet. */
  pickConfirmationWords(): number[] {
    const picked = new Set<number>();
    const byte = new Uint8Array(1);
    while (picked.size < CONFIRMATION_WORDS) {
      crypto.getRandomValues(byte);
      // 252 = 21 * 12: rejecting larger bytes keeps every position equally likely.
      if ((byte[0] as number) < 252) picked.add((byte[0] as number) % 12);
    }
    return [...picked].sort((a, b) => a - b);
  }

  confirmWords(phrase: string, answers: Record<number, string>): boolean {
    const words = phrase.trim().split(/\s+/);
    const entries = Object.entries(answers);
    return entries.length === CONFIRMATION_WORDS && entries.every(([i, word]) => words[Number(i)] === word.trim().toLowerCase());
  }

  async exists(): Promise<boolean> {
    return (await this.repository.load()) !== null;
  }

  /** Creates (or imports) a wallet from a standard recovery phrase and unlocks it. */
  async createFromPhrase(phrase: string, password: string): Promise<Account> {
    const mnemonic = this.normalizePhrase(phrase);
    const first = this.derivedAccount(mnemonic, 0);
    return this.start({ mnemonic, accounts: [first] }, password);
  }

  /** Creates a wallet from a single private key (no recovery phrase) and unlocks it. */
  async importPrivateKey(privateKey: string, password: string): Promise<Account> {
    return this.start({ mnemonic: null, accounts: [this.importedAccount(privateKey, 1)] }, password);
  }

  /** BRD 2.2.14.3: a forgotten password is replaced by importing the recovery phrase again. */
  async reset(phrase: string, password: string): Promise<Account> {
    await this.repository.remove();
    this.lock();
    return this.createFromPhrase(phrase, password);
  }

  // --- password and lock (BRD 2.2.14.3) ---

  async unlock(password: string): Promise<void> {
    const content = await this.repository.load();
    if (!content) throw new AppError(404, 'NO_WALLET', 'No wallet exists yet');
    const { doc, vaultKey } = await open(content, password);
    this.doc = doc;
    this.vaultKey = vaultKey;
  }

  /** Drops the decrypted wallet and the key from memory; a locked wallet signs nothing. */
  lock(): void {
    this.doc = null;
    this.vaultKey = null;
  }

  get isUnlocked(): boolean {
    return this.doc !== null;
  }

  // --- accounts (BRD 2.2.14.2) ---

  accounts(): Account[] {
    return this.unlocked().accounts.map((a) => ({ ...a, privateKey: undefined }));
  }

  activeAccount(): Account {
    const doc = this.unlocked();
    return this.accountById(doc.activeAccountId, doc);
  }

  hasRecoveryPhrase(): boolean {
    return this.unlocked().mnemonic !== null;
  }

  /** Derives the next account from the recovery phrase. */
  async addAccount(): Promise<Account> {
    const doc = this.unlocked();
    if (!doc.mnemonic) throw new AppError(409, 'NO_RECOVERY_PHRASE', 'This wallet has no recovery phrase; import another private key instead');
    const next = Math.max(...doc.accounts.filter((a) => a.kind === 'derived').map((a) => a.index ?? 0), -1) + 1;
    const account = this.derivedAccount(doc.mnemonic, next);
    doc.accounts.push(account);
    await this.persist();
    return account;
  }

  async importAccount(privateKey: string): Promise<Account> {
    const doc = this.unlocked();
    const account = this.importedAccount(privateKey, doc.accounts.length + 1);
    if (doc.accounts.some((a) => a.address === account.address)) throw new AppError(409, 'ACCOUNT_EXISTS', 'This account is already in the wallet');
    doc.accounts.push(account);
    await this.persist();
    return account;
  }

  async setActiveAccount(id: string): Promise<void> {
    const doc = this.unlocked();
    this.accountById(id, doc);
    doc.activeAccountId = id;
    await this.persist();
  }

  /** The account's key as a viem account, for deposits, public sends and the pool-key signature. */
  signer(accountId = this.unlocked().activeAccountId): PrivateKeyAccount {
    const doc = this.unlocked();
    const account = this.accountById(accountId, doc);
    const key = account.kind === 'imported' ? (account.privateKey as Hex) : derivedKey(doc.mnemonic as string, account.index ?? 0);
    return privateKeyToAccount(key);
  }

  async markUsed(accountId: string): Promise<void> {
    const doc = this.unlocked();
    const account = this.accountById(accountId, doc);
    if (account.used) return;
    account.used = true;
    await this.persist();
  }

  // --- networks (BRD 2.2.14.5) ---

  networkId(): string {
    return this.unlocked().networkId;
  }

  async setNetwork(networkId: string): Promise<void> {
    this.unlocked().networkId = networkId;
    await this.persist();
  }

  // --- export and import (BRD 2.2.14.6) ---

  /** The whole wallet as one file, encrypted with the wallet password. */
  async exportFile(): Promise<string> {
    this.unlocked().lastExportAt = Date.now();
    await this.persist();
    return (await this.repository.load()) as string;
  }

  lastExportAt(): number | null {
    return this.unlocked().lastExportAt;
  }

  /** Restores a wallet from an export file and unlocks it; the file's password is required. */
  async importFile(content: string, password: string): Promise<void> {
    const { doc, vaultKey } = await open(content, password);
    this.doc = doc;
    this.vaultKey = vaultKey;
    await this.persist();
  }

  // --- data other modules keep per account and network ---

  /** Without `accountId` / `networkId`, the active account and the selected network at the time of the call. */
  readSection<T>(section: string, schema: z.ZodType<T>, accountId?: string, networkId?: string): T | undefined {
    const doc = this.unlocked();
    const value = doc.sections[this.sectionKey(section, accountId, networkId)];
    return value === undefined ? undefined : schema.parse(value);
  }

  async writeSection(section: string, value: unknown, accountId?: string, networkId?: string): Promise<void> {
    this.unlocked().sections[this.sectionKey(section, accountId, networkId)] = value;
    await this.persist();
  }

  // --- internals ---

  private sectionKey(section: string, accountId?: string, networkId?: string): string {
    const doc = this.unlocked();
    return `${accountId ?? doc.activeAccountId}/${networkId ?? doc.networkId}/${section}`;
  }

  private unlocked(): WalletDocument {
    if (!this.doc) throw new AppError(423, 'WALLET_LOCKED', 'The wallet is locked');
    return this.doc;
  }

  private accountById(id: string, doc: WalletDocument): Account {
    const account = doc.accounts.find((a) => a.id === id);
    if (!account) throw new AppError(404, 'NO_ACCOUNT', 'No such account');
    return account;
  }

  private normalizePhrase(phrase: string): string {
    const mnemonic = phrase.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(mnemonic, wordlist)) throw new AppError(400, 'INVALID_PHRASE', 'This is not a valid recovery phrase');
    return mnemonic;
  }

  private derivedAccount(mnemonic: string, index: number): Account {
    const address = privateKeyToAccount(derivedKey(mnemonic, index)).address;
    return { id: address, label: `Account ${index + 1}`, kind: 'derived', index, address, used: false };
  }

  private importedAccount(privateKey: string, n: number): Account {
    const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    if (!isHex(key) || key.length !== 66) throw new AppError(400, 'INVALID_PRIVATE_KEY', 'This is not a valid private key');
    const address = privateKeyToAccount(key).address;
    return { id: address, label: `Imported ${n}`, kind: 'imported', privateKey: key, address, used: false };
  }

  private async start(init: Pick<WalletDocument, 'mnemonic' | 'accounts'>, password: string): Promise<Account> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(400, 'WEAK_PASSWORD', `The password needs at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const first = init.accounts[0] as Account;
    this.doc = { version: 1, ...init, activeAccountId: first.id, networkId: DEFAULT_NETWORK, lastExportAt: null, sections: {} };
    this.vaultKey = await deriveVaultKey(password, this.kdf);
    await this.persist();
    return first;
  }

  private async persist(): Promise<void> {
    if (!this.doc || !this.vaultKey) throw new AppError(423, 'WALLET_LOCKED', 'The wallet is locked');
    await this.repository.save(seal(this.vaultKey, this.doc));
  }
}
