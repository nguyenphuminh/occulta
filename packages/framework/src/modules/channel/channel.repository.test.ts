import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { MemoryStore } from '../storage/index.ts';
import { WalletRepository, WalletService } from '../wallet/index.ts';
import { ChannelRepository } from './channel.repository.ts';
import type { ChannelRecord } from './channel.schema.ts';

describe('ChannelRepository', () => {
  it('refuses every write once its session has ended, before touching what is stored', async () => {
    const wallet = new WalletService(new WalletRepository(new MemoryStore()), { N: 2 ** 10, r: 8, p: 1 });
    await wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
    const repository = new ChannelRepository(wallet, 'arbitrum-sepolia');
    repository.close();
    await expect(repository.save({ id: 'stale' } as ChannelRecord)).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    expect(new ChannelRepository(wallet, 'arbitrum-sepolia').all()).toEqual([]);
  });
});
