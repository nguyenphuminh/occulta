import { z } from 'zod';
import { HttpRelayer, type Occulta } from '@occulta/framework';

/**
 * What the user added for a network, for every account: relays and relayers (BRD 2.2.11), and RPC
 * endpoints tried before the network's own, which follow only while `rpcFallback` is on (BRD 2.2.14.5).
 */
const WebSettingsSchema = z.object({
  relayers: z.array(z.string()),
  libp2pRelays: z.array(z.string()),
  rpcUrls: z.array(z.string()).default([]),
  rpcFallback: z.boolean().default(true),
});
export type WebSettings = z.infer<typeof WebSettingsSchema>;

const SECTION = 'web-settings';
/** Network-wide data is kept in the encrypted wallet under this account id instead of a real one. */
const ALL_ACCOUNTS = '*';

export function readSettings(occulta: Occulta): WebSettings {
  return occulta.wallet.readSection(SECTION, WebSettingsSchema, ALL_ACCOUNTS) ?? { relayers: [], libp2pRelays: [], rpcUrls: [], rpcFallback: true };
}

export async function writeSettings(occulta: Occulta, settings: WebSettings): Promise<void> {
  await occulta.wallet.writeSection(SECTION, settings, ALL_ACCOUNTS);
  await startNode(occulta);
}

/** (Re)starts the node with the network's relays and relayers, the user's own first. */
export async function startNode(occulta: Occulta): Promise<void> {
  const own = readSettings(occulta);
  const network = occulta.network();
  occulta.configure({
    relayers: [...own.relayers, ...network.relayers].map((url) => new HttpRelayer(url)),
    libp2pRelays: [...own.libp2pRelays, ...network.libp2pRelays],
    rpcUrls: own.rpcUrls,
    rpcFallback: own.rpcFallback,
  });
  await occulta.start();
}
