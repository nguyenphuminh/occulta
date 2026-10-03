import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>;

/** A chain configuration: one of the four built-in ones, or a custom one (BRD 2.2.13). */
export const NetworkConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),
  explorerUrl: z.string().url().optional(),
  usdg: address,
  /** Absent until Occulta is deployed on this chain. */
  contracts: z
    .object({
      pool: address,
      disputes: address,
      /** First block to scan for pool events. */
      deployBlock: z.coerce.bigint(),
    })
    .optional(),
  /** Transaction relayers (HTTP endpoints). Users can add their own. */
  relayers: z.array(z.string().url()),
  /** libp2p relays (multiaddrs) that make peers reachable without exposing their IP. */
  libp2pRelays: z.array(z.string()),
});

export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

/** USDG addresses from Paxos's documentation (docs.paxos.com/guides/stablecoin/usdg). */
export const BUILT_IN_NETWORKS: readonly NetworkConfig[] = [
  {
    id: 'arbitrum-one',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    usdg: '0x004B506865409877C9fA29bfb1ebA929984B9bbC',
    relayers: [],
    libp2pRelays: [],
  },
  {
    id: 'arbitrum-sepolia',
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerUrl: 'https://sepolia.arbiscan.io',
    usdg: '0xFFC95faa3d63Cde504a05B567C600B78C0b41892',
    // Deployed 2026-10-02 (production build: 3–7 day dispute window).
    contracts: { pool: '0x5CfB7B562baa70135590162609B480d5773aDF5a', disputes: '0x9e4E216DF78Cb42ef7Cbe4Af779E4C114e9Eeb83', deployBlock: 314_992_300n },
    // The live relay host (npm run deploy:live): one desktop client as both relayer and libp2p relay.
    relayers: ['https://relay.occulta.space'],
    libp2pRelays: ['/dns4/relay.occulta.space/tcp/443/wss/p2p/12D3KooWExZXWgpmX2sTEGGKNMniT7aMirRHAH2wnoMZVt1Y6ue3'],
  },
  {
    id: 'robinhood-mainnet',
    name: 'Robinhood Chain',
    chainId: 4663,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    relayers: [],
    libp2pRelays: [],
  },
  {
    id: 'robinhood-testnet',
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    usdg: '0x7E955252E15c84f5768B83c41a71F9eba181802F',
    relayers: [],
    libp2pRelays: [],
  },
];
