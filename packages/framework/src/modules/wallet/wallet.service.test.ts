import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryStore } from '../storage/index.ts';
import { WalletRepository } from './wallet.repository.ts';
import { WalletService } from './wallet.service.ts';

// The standard test phrase: every wallet (MetaMask included) derives these addresses from it.
const PHRASE = 'test test test test test test test test test test test junk';
const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ACCOUNT_0_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse';

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error('expected an error');
};

describe('wallet', () => {
  let store: MemoryStore;
  let wallet: WalletService;

  beforeEach(() => {
    store = new MemoryStore();
    wallet = new WalletService(new WalletRepository(store), FAST_KDF);
  });

  it('generates a 12-word phrase and checks the three requested words', () => {
    const phrase = wallet.generatePhrase();
    const words = phrase.split(' ');
    expect(words).toHaveLength(12);
    const picks = wallet.pickConfirmationWords();
    expect(new Set(picks).size).toBe(3);
    const right = Object.fromEntries(picks.map((i) => [i, words[i] as string]));
    expect(wallet.confirmWords(phrase, right)).toBe(true);
    const wrong = { ...right, [picks[0] as number]: 'zoo' };
    expect(wallet.confirmWords(phrase, wrong)).toBe(false);
    expect(wallet.confirmWords(phrase, { [picks[0] as number]: words[picks[0] as number] as string })).toBe(false);
  });

  it('derives the same addresses as other standard wallets, in the same order', async () => {
    const first = await wallet.createFromPhrase(PHRASE, PASSWORD);
    expect(first.address).toBe(ACCOUNT_0);
    expect((await wallet.addAccount()).address).toBe(ACCOUNT_1);
    expect(wallet.signer(first.id).address).toBe(ACCOUNT_0);
  });

  it('rejects short passwords and invalid phrases or keys', async () => {
    expect(await code(wallet.createFromPhrase(PHRASE, 'short'))).toBe('WEAK_PASSWORD');
    expect(await code(wallet.createFromPhrase('not a real phrase at all', PASSWORD))).toBe('INVALID_PHRASE');
    expect(await code(wallet.importPrivateKey('0x1234', PASSWORD))).toBe('INVALID_PRIVATE_KEY');
    expect(await wallet.exists()).toBe(false);
  });

  it('stores nothing unencrypted, unlocks only with the password, and signs nothing while locked', async () => {
    await wallet.createFromPhrase(PHRASE, PASSWORD);
    const stored = (await store.get('occulta.wallet')) as string;
    expect(stored).not.toContain('junk');
    expect(stored.toLowerCase()).not.toContain(ACCOUNT_0.slice(2).toLowerCase());
    wallet.lock();
    expect(() => wallet.signer()).toThrow(/locked/);
    expect(await code(wallet.unlock('wrong password'))).toBe('WRONG_PASSWORD');
    await wallet.unlock(PASSWORD);
    expect(wallet.activeAccount().address).toBe(ACCOUNT_0);
  });

  it('imports private keys; a wallet without a phrase can only add accounts by importing', async () => {
    await wallet.importPrivateKey(ACCOUNT_0_KEY, PASSWORD);
    expect(wallet.activeAccount().address).toBe(ACCOUNT_0);
    expect(wallet.hasRecoveryPhrase()).toBe(false);
    expect(await code(wallet.addAccount())).toBe('NO_RECOVERY_PHRASE');
    expect(await code(wallet.importAccount(ACCOUNT_0_KEY))).toBe('ACCOUNT_EXISTS');
    const second = await wallet.importAccount('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    expect(second.address).toBe(ACCOUNT_1);
    expect(wallet.accounts().every((a) => a.privateKey === undefined)).toBe(true);
  });

  it('keeps each account and network apart', async () => {
    const first = await wallet.createFromPhrase(PHRASE, PASSWORD);
    const second = await wallet.addAccount();
    const schema = z.object({ n: z.number() });
    await wallet.writeSection('notes', { n: 1 });
    await wallet.writeSection('notes', { n: 2 }, second.id);
    await wallet.setNetwork('robinhood-testnet');
    expect(wallet.readSection('notes', schema)).toBeUndefined();
    await wallet.setNetwork('arbitrum-sepolia');
    expect(wallet.readSection('notes', schema)).toEqual({ n: 1 });
    expect(wallet.readSection('notes', schema, second.id)).toEqual({ n: 2 });
    expect(wallet.activeAccount().id).toBe(first.id);
  });

  it('starts on Arbitrum Sepolia', async () => {
    await wallet.createFromPhrase(PHRASE, PASSWORD);
    expect(wallet.networkId()).toBe('arbitrum-sepolia');
  });

  it('exports one encrypted file that restores everything in a fresh store', async () => {
    await wallet.createFromPhrase(PHRASE, PASSWORD);
    await wallet.addAccount();
    await wallet.writeSection('channels', { open: ['ch1'] });
    const file = await wallet.exportFile();
    expect(wallet.lastExportAt()).toBeTypeOf('number');

    const elsewhere = new WalletService(new WalletRepository(new MemoryStore()), FAST_KDF);
    expect(await code(elsewhere.importFile(file, 'not the password'))).toBe('WRONG_PASSWORD');
    expect(await code(elsewhere.importFile('{"hello":1}', PASSWORD))).toBe('INVALID_WALLET_FILE');
    await elsewhere.importFile(file, PASSWORD);
    expect(elsewhere.accounts().map((a) => a.address)).toEqual([ACCOUNT_0, ACCOUNT_1]);
    expect(elsewhere.readSection('channels', z.object({ open: z.array(z.string()) }))).toEqual({ open: ['ch1'] });
    elsewhere.lock();
    await elsewhere.unlock(PASSWORD);
    expect(elsewhere.hasRecoveryPhrase()).toBe(true);
  });

  it('resets a forgotten password by importing the phrase again, which drops channel data', async () => {
    await wallet.createFromPhrase(PHRASE, PASSWORD);
    await wallet.writeSection('channels', { open: ['ch1'] });
    wallet.lock();
    await wallet.reset(PHRASE, 'a brand new password');
    expect(wallet.activeAccount().address).toBe(ACCOUNT_0);
    expect(wallet.readSection('channels', z.unknown())).toBeUndefined();
    wallet.lock();
    expect(await code(wallet.unlock(PASSWORD))).toBe('WRONG_PASSWORD');
    await wallet.unlock('a brand new password');
  });
});
