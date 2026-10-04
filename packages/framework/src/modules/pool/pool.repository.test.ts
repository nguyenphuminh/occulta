import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { MemoryStore } from '../storage/index.ts';
import { WalletRepository, WalletService } from '../wallet/index.ts';
import { PoolRepository } from './pool.repository.ts';

describe('PoolRepository', () => {
  it('keeps writing to its own network and account even after the user switches', async () => {
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), { N: 2 ** 10, r: 8, p: 1 });
    const first = await wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
    const repository = new PoolRepository(wallet, 'arbitrum-sepolia');
    await wallet.setNetwork('other-network');
    const second = await wallet.addAccount();
    await wallet.setActiveAccount(second.id);

    await repository.save({ syncedBlock: 42n, notes: [] }, first.id);
    expect(repository.load(first.id).syncedBlock).toBe(42n);
    expect(new PoolRepository(wallet).load(first.id).syncedBlock).toBe(-1n); // the selected network is untouched
    expect(new PoolRepository(wallet, 'arbitrum-sepolia').load(second.id).syncedBlock).toBe(-1n);
  });
});
