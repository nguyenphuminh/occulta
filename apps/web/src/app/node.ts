import { BUILT_IN_NETWORKS, NetworkConfigSchema, Occulta, urlArtifacts, type NetworkConfig } from '@occulta/framework';
import { createBrowserNode } from '@occulta/framework/libp2p-browser';
import { IdbStore } from '../shared/idb.store.ts';
import type { Prompts } from './prompts.ts';
import { WorkerProver } from './worker-prover.ts';

/** How long a peer waits for an answer before its channel proposal fails (the P2P request timeout is 60 s). */
const APPROVAL_TIMEOUT_MS = 50_000;

/** Extra chains given to the dev server (one or a list), e.g. the local dev node in UI tests. Absent in normal builds. */
function devNetworks(): NetworkConfig[] {
  const raw = import.meta.env.VITE_OCCULTA_DEV_NETWORK as string | undefined;
  return raw ? [JSON.parse(raw) as unknown].flat().map((n) => NetworkConfigSchema.parse(n)) : [];
}

/** The website's composition root: the framework node with the browser's storage, proving files and libp2p. */
export function createOcculta(prompts: Prompts): Occulta {
  return new Occulta({
    store: new IdbStore(),
    artifacts: urlArtifacts(`${location.origin}/artifacts`),
    prover: new WorkerProver(`${location.origin}/artifacts`),
    createNode: createBrowserNode,
    networks: [...BUILT_IN_NETWORKS, ...devNetworks()],
    // BRD 2.2.7: a channel that needs none of the user's money opens without asking.
    approveOpen: (request) => (request.peerAmount === 0n ? Promise.resolve(true) : prompts.ask({ kind: 'approve-open', request }, APPROVAL_TIMEOUT_MS)),
    // The channel of an accepted request takes its place in the channel list (BRD 2.2.14.9).
    onJoined: (channelId) => prompts.joined(channelId),
    // BRD 2.2.8: no outgoing payment is signed without the user's confirmation in the wallet's dialog.
    confirmPayment: (payment) => prompts.ask({ kind: 'confirm-payment', ...payment }),
  });
}
