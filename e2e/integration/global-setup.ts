// Starts the dev node and builds the contracts (dev-node variant) once for the whole run.
import { startDevnode } from '../../scripts/lib/devnode.ts';
import { buildContracts } from '../../scripts/lib/stylus.ts';

export default async function setup(): Promise<void> {
  await startDevnode();
  buildContracts({ e2e: true });
}
