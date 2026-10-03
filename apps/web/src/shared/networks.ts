import type { NetworkConfig } from '@occulta/framework';
import arbitrumLogomark from './arbitrum-logomark.svg';

/** Arbitrum One, Nova and Sepolia: networks shown with Arbitrum's logomark. */
const ARBITRUM_CHAINS = new Set([42161, 42170, 421614]);

/**
 * The network's logo, if it has one: Arbitrum's logomark from its brand kit (arbitrum.io/brand-kit),
 * used as published, shown at its minimum size of 24px with clear space of half the hexagon's width.
 */
export const networkLogo = (network: NetworkConfig): string | null => (ARBITRUM_CHAINS.has(network.chainId) ? arbitrumLogomark : null);
