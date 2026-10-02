# Occulta

Private two-party payment channels inside a zero-knowledge shielded pool on Arbitrum ("layer 3" for
payments). Deposits, private transfers, withdrawals, channel funding and cooperative closes are all
ordinary-looking pool transfers; only a dispute is visible as such.

| Part | Where | What |
|---|---|---|
| Framework | `packages/framework` | The channel node as a TypeScript library: wallet core, pool, channels, disputes, libp2p messaging, relayer client. Runs in Node.js and the browser. |
| Wallet website | `apps/web` | React + Vite + Viem. The only UI, with its own built-in wallet. |
| Desktop client | `apps/desktop` | Node.js CLI and local RPC server; optional transaction relayer and libp2p relay. |
| Circuits | `circuits` | Circom 2 circuits (transfer, submit state, finalize, reclaim) and the Groth16 setup. |
| Contracts | `contracts` | Arbitrum Stylus (Rust): Pool, Disputes, a Groth16 verifier and a Poseidon hasher. |
| Tests | `e2e` | Integration tests on a local Nitro dev node and Playwright UI tests. |

## Setup

Linux, about 3 GB of disk.

```sh
scripts/setup-tools.sh      # Node 24, Rust 1.91 + wasm target, circom, wasm-tools, Nitro dev node, powers of tau
source scripts/env.sh       # puts those tools on PATH (each new shell)
npm install
npm run setup               # builds the circuits and proving files, test fixtures, installs the git hooks
npx playwright install chromium   # for the UI tests
```

## Running it locally

```sh
npm run devnode -- start                  # local Nitro dev node on http://127.0.0.1:8547
npm run deploy:devnode                    # contracts + a test USDG; writes .devnode/deployment.json
```

Desktop client (`node apps/desktop/src/main.ts help` lists every option). Secrets come from
`OCCULTA_PASSWORD` / `OCCULTA_SECRET` or a hidden prompt, never from flags:

```sh
node apps/desktop/src/main.ts init --phrase            # or --private-key, or --import-file <website export>
node apps/desktop/src/main.ts start --rpc              # interactive shell; type "help"
node apps/desktop/src/main.ts start --relayer --relayer-account <unused account> \
  --relayer-fee-eth 0.0001 --relayer-fee-usdg 0.01 --libp2p-relay   # also serve others
```

A custom chain (e.g. the dev node) is passed with `--network-file <json> --network <id>`, in the
format of the built-in configurations in `packages/framework/src/modules/chain/chain.config.ts`.
The website gets one through `VITE_OCCULTA_DEV_NETWORK` (the same JSON) when it is started with
`npm run dev -w @occulta/web`. Browsers on an `https` page can only reach `wss://` relays, so a public
libp2p relay needs TLS in front of it.

## Tests

```sh
npm test                    # every tier, in order, with a summary table
npm test -- --fast          # without the slow tiers (integration, ui)
npm test -- --only ui       # one tier: lint, typecheck, contracts-lint, framework, circuits,
                            # contracts, desktop, web, integration, ui
npm run test:impact         # only the tiers affected by your changes since main
```

The git hooks run the affected fast tiers before each commit and the affected tiers (slow ones
included) before each push. The integration and UI tiers start the dev node themselves and deploy
fresh contracts built with a 10-second minimum dispute window (production builds keep 3–7 days).
The UI tests run the real desktop client as the website's transaction relayer and libp2p relay.

## Trusted setup

Groth16 needs a trusted setup per circuit. The team ran it itself: phase 1 is the public PSE
perpetual powers of tau (`ppot_0080_17.ptau`, downloaded by `scripts/setup-tools.sh`), and phase 2 is
a single contribution made by the team in `circuits/scripts/build.ts` with fresh random entropy. Anyone
who kept that entropy could forge proofs, so this setup is for testing and the hackathon only; a
production deployment needs a multi-party phase-2 ceremony.

## Deploying to public networks

Arbitrum Sepolia is deployed (production build, 3–7 day dispute window), and its built-in
configuration points at it:

| Contract | Arbitrum Sepolia |
|---|---|
| Pool | `0x5CfB7B562baa70135590162609B480d5773aDF5a` |
| Disputes | `0x9e4E216DF78Cb42ef7Cbe4Af779E4C114e9Eeb83` |
| Groth16 verifier | `0x8A7f9CC5635cf809e4c44AD3f0021237F84D6770` |
| Poseidon hasher | `0x154052BAD5D2D3c79d31FDF731E46586144646F2` |

It still lists no transaction relayers or libp2p relays: until some are published, users add their
own (e.g. a desktop client) in the website's settings. Arbitrum One and the Robinhood chains are not
deployed yet. Deploying needs a funded deployer key on each chain:

```sh
OCCULTA_DEPLOYER_KEY=0x… npm run deploy:network -- --network arbitrum-sepolia
```

It deploys the production build (3–7 day dispute window) against the chain's real USDG and prints a
`contracts` block: add it to the network's entry in `chain.config.ts`, and list the transaction
relayers and libp2p relays that serve that network.

## Gas (dev node, measured by the integration tests)

| Operation | Gas |
|---|---|
| Deposit (ETH / USDG) | ~2.56M / ~2.21M |
| Private transfer, channel funding, withdrawal | ~2.5–2.6M |
| Cooperative close | ~2.67M |
| Submit a state (start or answer a dispute) | ~0.39–0.46M |
| Finalize / reclaim | ~2.57M / ~2.53M |

Most of it is the Poseidon hashing of the commitment tree inside Stylus (about 90k gas per hash).
