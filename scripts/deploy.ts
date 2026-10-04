// npm run deploy:devnode [-- --e2e]
// Deploys the Occulta contracts and a test USDG token to the local dev node and writes
// .devnode/deployment.json, which the tests, the desktop client and the wallet website read.
// (Public networks need a funded key and the chain's real USDG; see README "Deploying".)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVNODE_DIR, devPublicClient, devWalletClient, startDevnode } from './lib/devnode.ts';
import { deployOcculta } from './lib/stylus.ts';
import { deployTestToken } from './lib/test-token.ts';

const e2e = process.argv.includes('--e2e');
await startDevnode();
const wallet = devWalletClient();
const client = devPublicClient();
const usdg = await deployTestToken(wallet, client);
const deployment = await deployOcculta(wallet, client, usdg, { e2e });
mkdirSync(DEVNODE_DIR, { recursive: true });
writeFileSync(join(DEVNODE_DIR, 'deployment.json'), JSON.stringify({ ...deployment, e2eShortWindow: e2e }, null, 2));
console.log(JSON.stringify(deployment, null, 2));
