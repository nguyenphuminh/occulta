# 1. Introduction

Occulta is a ZK state channel layer 3 on Arbitrum, providing instant near-zero-cost transactions that are fully private, powered by ZK SNARKs.

Users deposit ETH or USDG into a shielded pool, then open payment channels funded by their private notes and pay each other off-chain over an encrypted peer-to-peer link. Opening and closing a channel look like ordinary private transfers, so nobody watching the chain can tell a channel exists, who is in it, or how much moves through it.

# 2. Demo material

| | |
|---|---|
| HackQuest | [link to be added] |
| Demo video | [link to be added] |
| Website | <https://occulta.space> |
| GitHub | [repository link to be added] |
| Relayer and libp2p relay | <https://relay.occulta.space> |

Contracts on Arbitrum Sepolia (production build, 3–7 day dispute window):

| Contract | Address |
|---|---|
| Pool | [`0x5CfB7B562baa70135590162609B480d5773aDF5a`](https://sepolia.arbiscan.io/address/0x5CfB7B562baa70135590162609B480d5773aDF5a) |
| Disputes | [`0x9e4E216DF78Cb42ef7Cbe4Af779E4C114e9Eeb83`](https://sepolia.arbiscan.io/address/0x9e4E216DF78Cb42ef7Cbe4Af779E4C114e9Eeb83) |
| Groth16 verifier | [`0x8A7f9CC5635cf809e4c44AD3f0021237F84D6770`](https://sepolia.arbiscan.io/address/0x8A7f9CC5635cf809e4c44AD3f0021237F84D6770) |
| Poseidon hasher | [`0x154052BAD5D2D3c79d31FDF731E46586144646F2`](https://sepolia.arbiscan.io/address/0x154052BAD5D2D3c79d31FDF731E46586144646F2) |

# 3. Tech stack

- **Smart contracts:** Arbitrum Stylus (Rust, stylus-sdk, alloy)
- **ZK:** Circom, Groth16 on BN254, snarkjs, Poseidon
- **Signatures:** EdDSA on Baby Jubjub
- **Encryption:** X25519, HKDF-SHA256, XChaCha20-Poly1305 (noble)
- **Core utils:** TypeScript, viem
- **P2P:** libp2p (circuit relay v2, WebSockets, Noise, Yamux)
- **Web UI:** React, Vite
- **Desktop client:** Node.js, Express
- **Network and tokens:** Arbitrum Sepolia, ETH, Paxos USDG

# 4. Setup

## 4.1. Requirements

- Linux, with about 3 GB of free disk.
- The tools below, all installed by `scripts/setup-tools.sh`:
  - Node 24;
  - Rust 1.91 with the wasm target;
  - circom and wasm-tools;
  - the Nitro dev node;
  - the powers of tau.
- Chromium for the UI tests, installed through Playwright.

The repository holds:

| Part | Where | What |
|---|---|---|
| Framework | `packages/framework` | The channel node as a TypeScript library: wallet core, pool, channels, disputes, libp2p messaging, relayer client. Runs in Node.js and the browser. |
| Wallet website | `apps/web` | React + Vite + Viem. The only UI, with its own built-in wallet. |
| Desktop client | `apps/desktop` | Node.js CLI and local RPC server; optional transaction relayer and libp2p relay. |
| Circuits | `circuits` | Circom 2 circuits (transfer, submit state, finalize, reclaim) and the Groth16 setup. |
| Contracts | `contracts` | Arbitrum Stylus (Rust): Pool, Disputes, a Groth16 verifier and a Poseidon hasher. |
| Tests | `e2e` | Integration tests on a local Nitro dev node, Playwright UI tests, and live tests. |

## 4.2. How to run

### Install

```sh
scripts/setup-tools.sh      # Node 24, Rust 1.91 + wasm target, circom, wasm-tools, Nitro dev node, powers of tau
source scripts/env.sh       # puts those tools on PATH (each new shell)
npm install
npm run setup               # builds the circuits and proving files, test fixtures, installs the git hooks
npx playwright install chromium   # for the UI tests
```

### Try it

```sh
npm run demo                 # everything on this machine: a local chain, the desktop client as relayer
                             # and libp2p relay, and the website at http://127.0.0.1:5173
npm run demo -- fund <address> [eth] [usdg]    # test money for a wallet on the local chain
npm run demo -- --sepolia    # the website and a local relayer/relay on Arbitrum Sepolia
```

On the local chain, pick the network "Local dev chain" in the wallet; its relayer and relay are already set. On Sepolia, add the printed relayer and relay in Settings, fund your wallet with Sepolia ETH, and send the printed relayer account some ETH for gas. Use a second browser profile as the other side of a channel. Ctrl+C stops everything.

### Run the pieces yourself

```sh
npm run devnode -- start                  # local Nitro dev node on http://127.0.0.1:8547
npm run deploy:devnode                    # contracts + a test USDG; writes .devnode/deployment.json
```

The desktop client (`node apps/desktop/src/main.ts help` lists every option) takes its secrets from `OCCULTA_PASSWORD` and `OCCULTA_SECRET`, or a hidden prompt, never from flags:

```sh
node apps/desktop/src/main.ts init --phrase            # or --private-key, or --import-file <website export>
node apps/desktop/src/main.ts start --rpc              # interactive shell; type "help"
node apps/desktop/src/main.ts start --relayer --relayer-account <unused account> \
  --relayer-fee-eth 0.0001 --relayer-fee-usdg 0.01 --libp2p-relay   # also serve others
```

- **RPC endpoints:** the chain is read through RPC endpoints. Arbitrum Sepolia comes with Arbitrum's public endpoint, then PublicNode's and Tenderly's. Users add their own in the website's network settings, or with `--chain-rpcs <url,url>` on the desktop client. Theirs are tried first, and `--no-chain-rpc-fallback` (or the switch in the settings) keeps the wallet from ever using the public ones.
- **A custom chain** (for example the dev node) is passed with `--network-file <json> --network <id>`, in the format of the built-in configurations in `packages/framework/src/modules/chain/chain.config.ts`. The website gets them through `VITE_OCCULTA_DEV_NETWORK` (the same JSON, or a list of them) when it is started with `npm run dev -w @occulta/web`.
- **Public relays need TLS:** browsers on an `https` page can only reach `wss://` relays, so a public libp2p relay needs TLS in front of it.

### Tests

```sh
npm test                    # every tier, in order, with a summary table
npm test -- --fast          # without the slow tiers (integration, ui)
npm test -- --only ui       # one tier: lint, typecheck, contracts-lint, framework, circuits,
                            # contracts, desktop, web, integration, ui
npm run test:impact         # only the tiers affected by your changes since main
```

- **Git hooks:** they run the affected fast tiers before each commit, and the affected tiers (slow ones included) before each push.
- **Integration and UI tiers:** they start the dev node themselves and deploy fresh contracts built with a 10-second minimum dispute window; production builds keep 3–7 days.
- **UI tests:** they run the real desktop client as the website's transaction relayer and libp2p relay.

### Deploy the contracts to Arbitrum Sepolia

Occulta runs on Arbitrum Sepolia only, its one built-in network, and is already deployed there (contract addresses in section 2). Its built-in configuration lists the live relay host, `https://relay.occulta.space`: one desktop client that is both transaction relayer and libp2p relay. Users can add their own in the website's settings. Deploying again needs a funded deployer key:

```sh
OCCULTA_DEPLOYER_KEY=0x… npm run deploy:network -- --network arbitrum-sepolia
```

It deploys the production build (3–7 day dispute window) against the chain's real USDG and prints a `contracts` block. Add it to the network's entry in `chain.config.ts`, and list the transaction relayers and libp2p relays that serve that network.

### Verify the deployed contracts

Explorers verify a Stylus contract by rebuilding it with cargo-stylus and comparing the compressed code byte for byte. These contracts were deployed with the repository's own build, in `scripts/lib/stylus.ts`. It does what cargo-stylus does, but compresses with a newer brotli:

- **The Poseidon hasher** compresses to the same bytes either way. It is verifiable on Arbiscan and Blockscout with cargo-stylus 0.6.3, from a copy of the contracts laid out for the explorers' build.
- **The verifier, pool and disputes contracts** contain exactly the Wasm a cargo-stylus build gives, but it compresses differently, so explorers cannot verify them.

Anyone can check all four instead:

```sh
npm run verify:contracts
```

- **What it checks:** it takes the pool's address from the network configuration and the verifier, hasher and disputes addresses from the pool's storage. It rebuilds all four contracts from this source and compares each one, byte for byte, with the code on Arbitrum Sepolia.
- **Source paths:** the deployed code contains the source paths of the machine that built it, in its panic messages, so the rebuild maps its own paths to those.
- **Requirements:** Rust 1.91.0, from `contracts/rust-toolchain.toml`, and wasm-tools 1.260.0. `scripts/setup-tools.sh` installs both.

### Live deployment

The two live pieces:
- **The website** runs at **https://occulta.space**, on Cloudflare Workers static assets.
- **The relay host** runs at **relay.occulta.space**: one Google Cloud e2-small VM running the desktop client as relayer and libp2p relay for Arbitrum Sepolia, behind Caddy with automatic HTTPS.

One command deploys the current commit and is safe to run again:

```sh
npm run deploy:live -- --project occulta-space
```

It needs:
- a clean git tree;
- a signed-in `gcloud` (`~/.local/opt/google-cloud-sdk/bin/gcloud auth login`);
- Cloudflare's browser sign-ins (`npx wrangler login`, then `~/.local/bin/cloudflared tunnel login` choosing occulta.space), or an API token in `~/.occulta-secrets/cloudflare.token`.

What it does:
- creates what is missing: the relay's wallet in `.occulta/live/`, a static IP, a firewall rule, the VM and the DNS record;
- tops up the relayer's gas from `~/.occulta-secrets/funder.key`, when that file exists;
- installs the release and deploys the website;
- checks the relayer over HTTPS, and a relay reservation from outside.

`npm run test:live` then runs the user flows in a browser against the live site:
- The flows use real Sepolia transactions, paid from the funder key and swept back at the end.
- Each test wallet's phrase is kept in `.occulta/live/test-wallets.jsonl`, in case a run leaves money behind.
- Live runs never start a dispute: settling one takes the contracts' 3–7 day window, so its money would be lost. The dev-chain UI tests cover disputes with a short window.

### Trusted setup

Groth16 needs a trusted setup per circuit, and the team ran it itself:
- **Phase 1:** the public PSE perpetual powers of tau (`ppot_0080_17.ptau`, downloaded by `scripts/setup-tools.sh`).
- **Phase 2:** a single contribution made by the team in `circuits/scripts/build.ts`, with fresh random entropy.

Anyone who kept that entropy could forge proofs, so this setup is for testing and the hackathon only. A production deployment needs a multi-party phase-2 ceremony.

### Gas (dev node, measured by the integration tests)

| Operation | Gas |
|---|---|
| Deposit (ETH / USDG) | ~2.56M / ~2.21M |
| Private transfer, channel funding, withdrawal | ~2.5–2.6M |
| Cooperative close | ~2.67M |
| Submit a state (start or answer a dispute) | ~0.39–0.46M |
| Finalize / reclaim | ~2.57M / ~2.53M |

Most of it is the Poseidon hashing of the commitment tree inside Stylus (about 90k gas per hash).

# 5. Copyright and License

Copyright (c) 2026 Nguyen Phu Minh. Occulta is released under the [MIT License](LICENSE).

Third-party dependencies keep their own licenses. In particular, snarkjs, ffjavascript and circomlib are licensed under GPL-3.0.
