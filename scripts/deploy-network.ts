// npm run deploy:network -- --network arbitrum-sepolia        (one of the built-in networks)
// npm run deploy:network -- --network-file <json>              (a custom chain configuration)
// Deploys the production contracts (3–7 day dispute window) with the chain's real USDG, from the key
// in OCCULTA_DEPLOYER_KEY (funded on that chain), and prints the `contracts` block to add to the
// network's entry in packages/framework/src/modules/chain/chain.config.ts.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BUILT_IN_NETWORKS, NetworkConfigSchema, type NetworkConfig } from '../packages/framework/src/modules/chain/index.ts';
import { deployOcculta } from './lib/stylus.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function networkOf(): NetworkConfig {
  const file = option('network-file');
  if (file) return NetworkConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const id = option('network');
  const network = BUILT_IN_NETWORKS.find((n) => n.id === id);
  if (!network) throw new Error(`--network must be one of ${BUILT_IN_NETWORKS.map((n) => n.id).join(', ')}, or pass --network-file`);
  return network;
}

const key = process.env.OCCULTA_DEPLOYER_KEY;
if (!key) throw new Error('Set OCCULTA_DEPLOYER_KEY to a private key funded on the target chain');
const network = networkOf();
const chain = defineChain({
  id: network.chainId,
  name: network.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(network.rpcUrl) });
if ((await client.getChainId()) !== network.chainId) throw new Error(`${network.rpcUrl} is not chain ${network.chainId}`);
const wallet = createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(network.rpcUrl) });
console.log(`deploying to ${network.name} from ${wallet.account.address}…`);
const deployment = await deployOcculta(wallet, client, network.usdg);
console.log(JSON.stringify({ contracts: { pool: deployment.pool, disputes: deployment.disputes, deployBlock: deployment.deployBlock.toString() } }, null, 2));
