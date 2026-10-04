// npm run verify:contracts
// Rebuilds the four Stylus contracts from this source and checks that they are, byte for byte, the
// code deployed on Arbitrum Sepolia. Block explorers rebuild with cargo-stylus, whose older brotli
// compresses the verifier, pool and disputes contracts differently, so they can verify only the hasher.
//
// The deployed code carries the source paths of the machine that built it (in panic messages), so
// this build maps its own paths to those. Needs Rust 1.91.0 (contracts/rust-toolchain.toml) and
// wasm-tools 1.260.0, whose text round trip is part of the build; scripts/setup-tools.sh installs both.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import { BUILT_IN_NETWORKS } from '../packages/framework/src/modules/chain/index.ts';
import { REPO } from './lib/devnode.ts';
import { buildContracts, type ContractName } from './lib/stylus.ts';

const WASM_TOOLS = 'wasm-tools 1.260.0';
/** Where the deployed build ran, on 2026-10-02. */
const DEPLOYED_FROM = { cargoHome: '/home/cpground/.cargo', sysroot: '/home/cpground/.rustup/toolchains/1.91.0-x86_64-unknown-linux-gnu', repo: '/home/cpground/Occulta' };

const network = BUILT_IN_NETWORKS.find((n) => n.id === 'arbitrum-sepolia');
if (!network?.contracts) throw new Error('no Arbitrum Sepolia deployment in the built-in networks');
const client = createPublicClient({ transport: http(network.rpcUrl) });

const found = execFileSync('wasm-tools', ['--version'], { encoding: 'utf8' }).trim();
if (found !== WASM_TOOLS) throw new Error(`needs ${WASM_TOOLS} (cargo install --locked wasm-tools@1.260.0), found ${found}`);

// The pool keeps the other three addresses in storage slots 1 (verifier), 2 (hasher) and 3 (disputes).
const { pool } = network.contracts;
const inSlot = async (slot: number) => `0x${((await client.getStorageAt({ address: pool, slot: toHex(slot, { size: 32 }) })) ?? '0x').slice(-40)}` as Address;
const addresses: Record<ContractName, Address> = { pool, verifier: await inSlot(1), hasher: await inSlot(2), disputes: await inSlot(3) };

const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { cwd: join(REPO, 'contracts'), encoding: 'utf8' }).trim();
const remapPaths: [string, string][] = [
  [process.env.CARGO_HOME ?? join(homedir(), '.cargo'), DEPLOYED_FROM.cargoHome],
  [sysroot, DEPLOYED_FROM.sysroot],
  [REPO, DEPLOYED_FROM.repo],
];

/** The Wasm inside Stylus code: 0xEFF00000 followed by its brotli compression. */
const wasmOf = (code: Hex) => (code.startsWith('0xeff00000') ? brotliDecompressSync(Buffer.from(code.slice(10), 'hex')) : Buffer.alloc(0));

let mismatch = false;
for (const { name, code } of buildContracts({ remapPaths })) {
  const built = toHex(code);
  const deployed = (await client.getCode({ address: addresses[name] })) ?? '0x';
  // Another brotli version may compress the same Wasm differently: then the Wasm decides.
  const sameWasm = wasmOf(built).equals(wasmOf(deployed));
  const verdict = built === deployed ? 'identical to the deployed code' : sameWasm ? 'same Wasm as the deployed code, compressed differently' : 'DIFFERENT from the deployed code';
  console.log(`${name.padEnd(9)} ${addresses[name]}  ${verdict}`);
  mismatch ||= !sameWasm;
}
process.exitCode = mismatch ? 1 : 0;
