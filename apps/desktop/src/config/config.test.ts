import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.ts';

describe('desktop configuration', () => {
  it('starts with safe defaults: no RPC, no relayer, no libp2p relay, shell on', () => {
    const c = loadConfig(['start', '--data-dir', '/tmp/o']);
    expect(c).toMatchObject({ command: 'start', dataDir: '/tmp/o', shell: true, tickSeconds: 15 });
    expect(c.rpc.enabled).toBe(false);
    expect(c.relayer.enabled).toBe(false);
    expect(c.libp2pRelay.enabled).toBe(false);
  });

  it('reads every role and list option', () => {
    const c = loadConfig([
      'start',
      '--rpc',
      '--rpc-port',
      '9000',
      '--relayer',
      '--relayer-account',
      '0xabc',
      '--relayer-fee-eth',
      '0.0001',
      '--relayer-fee-usdg',
      '0.01',
      '--libp2p-relay',
      '--libp2p-relay-announce',
      '/dns4/relay.example/tcp/443/wss',
      '--libp2p-relays',
      '/ip4/1.2.3.4/tcp/1/ws/p2p/x, /dns4/r/tcp/2/wss/p2p/y',
      '--relayers',
      'https://relay.example',
      '--chain-rpcs',
      'https://rpc.one.example, https://rpc.two.example',
      '--no-chain-rpc-fallback',
      '--no-shell',
      '--tick',
      '5',
    ]);
    expect(c.rpc).toMatchObject({ enabled: true, port: 9000 });
    expect(c.relayer).toMatchObject({ enabled: true, account: '0xabc', feeEth: '0.0001', feeUsdg: '0.01', port: 8646 });
    expect(c.libp2pRelays).toEqual(['/ip4/1.2.3.4/tcp/1/ws/p2p/x', '/dns4/r/tcp/2/wss/p2p/y']);
    expect(c.libp2pRelay).toMatchObject({ enabled: true, announce: ['/dns4/relay.example/tcp/443/wss'] });
    expect(c.relayers).toEqual(['https://relay.example']);
    expect(c.chainRpcs).toEqual(['https://rpc.one.example', 'https://rpc.two.example']);
    expect(c.chainRpcFallback).toBe(false);
    expect(c.shell).toBe(false);
    expect(c.tickSeconds).toBe(5);
  });

  it('fails fast on incomplete or invalid options', () => {
    expect(() => loadConfig(['init'])).toThrow(/--phrase, --private-key or --import-file/);
    expect(() => loadConfig(['start', '--relayer'])).toThrow(/--relayer-account/);
    expect(() => loadConfig(['start', '--rpc-port', '70000'])).toThrow();
    expect(() => loadConfig(['start', '--relayers', 'not a url'])).toThrow();
    expect(() => loadConfig(['launch'])).toThrow();
    expect(() => loadConfig(['start', '--unknown-flag'])).toThrow();
  });

  it('knows where an init wallet comes from', () => {
    expect(loadConfig(['init', '--phrase']).init.source).toBe('phrase');
    expect(loadConfig(['init', '--private-key']).init).toEqual({ source: 'private-key' });
    expect(loadConfig(['init', '--import-file', 'w.json']).init).toEqual({ source: 'import-file', importFile: 'w.json' });
  });
});
