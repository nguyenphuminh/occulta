import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { MemoryStore, Occulta } from '@occulta/framework';
import { NodeService, findCommand } from '../node/index.ts';
import { ShellService, helpText, inputOf, tokenize } from './shell.service.ts';

async function shell(): Promise<ShellService> {
  const occulta = new Occulta({
    store: new MemoryStore(),
    artifacts: async () => ({ wasm: '', zkey: '' }),
    createNode: async () => {
      throw new Error('no libp2p here');
    },
    kdf: { N: 2 ** 10, r: 8, p: 1 },
    // Offline: none of the network's own relayers or relays, whatever its configuration lists.
    relayers: [],
    libp2pRelays: [],
  });
  await occulta.wallet.createFromPhrase(generateMnemonic(wordlist, 128), 'password123');
  await occulta.start();
  return new ShellService(new NodeService(occulta, { roles: () => ({}) }));
}

describe('desktop shell', () => {
  it('splits lines into words and keeps quoted text together', () => {
    expect(tokenize('channel.pay abc 0.01')).toEqual(['channel.pay', 'abc', '0.01']);
    expect(tokenize(`  account.import "0x 12"  'a b' `)).toEqual(['account.import', '0x 12', 'a b']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('names positional words after the command’s arguments', () => {
    expect(inputOf(findCommand('channel.open'), ['code', 'eth', '0.1'])).toEqual({ invite: 'code', token: 'eth', amount: '0.1' });
    expect(() => inputOf(findCommand('channel.pay'), ['a', 'b', 'c'])).toThrow(/takes <channel> <amount>/);
  });

  it('lists every command with required and optional arguments', () => {
    const help = helpText();
    expect(help).toContain('withdraw <token> <amount> [to]');
    expect(help).toContain('channel.open <invite> <token> <amount> [peerAmount] [window]');
  });

  it('runs commands and prints errors in one format', async () => {
    const s = await shell();
    expect(JSON.parse(await s.execute('accounts'))).toHaveLength(1);
    expect(await s.execute('frobnicate')).toBe('error UNKNOWN_COMMAND: Unknown command "frobnicate"');
    expect(await s.execute('deposit eth')).toMatch(/^error INVALID_INPUT: amount/);
    expect(await s.execute('channels')).toBe('error NO_RELAY: Channels need a libp2p relay; add one in the network settings');
    expect(await s.execute('')).toBe('');
  });

  it('reads commands until "exit"', async () => {
    const s = await shell();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => (text += chunk.toString()));
    const done = s.run(input, output);
    input.write('account.add\naccounts\nexit\n');
    await done;
    expect(text).toContain('"label": "Account 2"');
    expect(text.match(/"label"/g)?.length).toBe(3);
  });
});
