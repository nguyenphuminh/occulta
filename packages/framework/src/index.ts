// Public API of the Occulta framework (BRD 2.2.13). Hosts build on `Occulta`; the module classes are
// exported for hosts that compose services themselves (the desktop client's relayer mode, tests).
export { Occulta } from './occulta.ts';
export type { OccultaOptions } from './occulta.ts';

export { AppError, isAppError } from './shared/errors/AppError.ts';
export { Prover, fileArtifacts, urlArtifacts } from './shared/integrations/prover.ts';
export type { ArtifactLoader, CircuitName, ProofResult, ProverPort } from './shared/integrations/prover.ts';

export * from './modules/chain/index.ts';
export * from './modules/channel/index.ts';
export * from './modules/dispute/index.ts';
export * from './modules/keys/index.ts';
export * from './modules/p2p/index.ts';
export * from './modules/pool/index.ts';
export * from './modules/relayer/index.ts';
export * from './modules/storage/index.ts';
export * from './modules/wallet/index.ts';
