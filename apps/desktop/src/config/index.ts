import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal amount such as 0.001');
const list = (value: string | undefined) => (value === undefined ? undefined : value.split(',').map((s) => s.trim()).filter(Boolean));

/** Everything the desktop client is started with; validated once at startup (fail fast). */
export const ConfigSchema = z
  .object({
    command: z.enum(['init', 'start', 'help']),
    dataDir: z.string().min(1),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    /** `init`: where the wallet comes from. The secret itself is read from OCCULTA_SECRET or a prompt. */
    init: z.object({ source: z.enum(['phrase', 'private-key', 'import-file']).nullable(), importFile: z.string().optional() }),
    network: z.string().optional(),
    /** A JSON file with one custom chain configuration (BRD 2.2.13), added to the built-in ones. */
    networkFile: z.string().optional(),
    libp2pRelays: z.array(z.string()).optional(),
    relayers: z.array(z.url()).optional(),
    maxFee: z.object({ eth: decimal.optional(), usdg: decimal.optional() }),
    rpc: z.object({ enabled: z.boolean(), port, tokenFile: z.string() }),
    relayer: z.object({ enabled: z.boolean(), host: z.string(), port, account: z.string().optional(), feeEth: decimal.optional(), feeUsdg: decimal.optional() }),
    libp2pRelay: z.object({ enabled: z.boolean(), host: z.string(), port }),
    shell: z.boolean(),
    tickSeconds: z.coerce.number().int().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.command === 'init' && !c.init.source) ctx.addIssue({ code: 'custom', message: 'init needs --phrase, --private-key or --import-file <path>' });
    if (c.relayer.enabled && (!c.relayer.account || !c.relayer.feeEth || !c.relayer.feeUsdg)) {
      ctx.addIssue({ code: 'custom', message: '--relayer needs --relayer-account <account>, --relayer-fee-eth <amount> and --relayer-fee-usdg <amount>' });
    }
  });

export type Config = z.output<typeof ConfigSchema>;

export const USAGE = `Usage:
  occulta init (--phrase | --private-key | --import-file <path>)   Create the encrypted data folder
  occulta start [options]                                           Run the node (interactive shell on a terminal)
  occulta help

Secrets: OCCULTA_PASSWORD (data password) and OCCULTA_SECRET (phrase or private key for init),
otherwise asked for on the terminal.

Options:
  --data-dir <dir>              Data folder (default ~/.occulta)
  --network <id>                Network to use (built-in id or the custom one)
  --network-file <path>         Custom chain configuration (JSON)
  --libp2p-relays <a,b>         libp2p relays for this node's channels
  --relayers <url,url>          Transaction relayers to use
  --max-fee-eth <amount>        Highest relayer fee to accept in ETH
  --max-fee-usdg <amount>       Highest relayer fee to accept in USDG
  --rpc                         Serve the local RPC API (127.0.0.1 only, access token)
  --rpc-port <port>             (default 8645)
  --rpc-token-file <path>       Where the access token is written (default ~/.config/occulta/rpc.json)
  --relayer                     Act as a transaction relayer
  --relayer-account <account>   Account that submits relayed transactions (never one with deposits or public sends)
  --relayer-fee-eth <amount>    Quoted fee in ETH
  --relayer-fee-usdg <amount>   Quoted fee in USDG
  --relayer-host <host>         (default 0.0.0.0)
  --relayer-port <port>         (default 8646)
  --libp2p-relay                Act as a libp2p relay for other users
  --libp2p-relay-host <host>    (default 0.0.0.0)
  --libp2p-relay-port <port>    (default 8647)
  --no-shell                    Do not open the interactive shell
  --tick <seconds>              Background sync and channel watching interval (default 15)
  --log-level <level>           (default info)`;

export function loadConfig(argv: string[]): Config {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      'data-dir': { type: 'string' },
      'log-level': { type: 'string' },
      phrase: { type: 'boolean' },
      'private-key': { type: 'boolean' },
      'import-file': { type: 'string' },
      network: { type: 'string' },
      'network-file': { type: 'string' },
      'libp2p-relays': { type: 'string' },
      relayers: { type: 'string' },
      'max-fee-eth': { type: 'string' },
      'max-fee-usdg': { type: 'string' },
      rpc: { type: 'boolean' },
      'rpc-port': { type: 'string' },
      'rpc-token-file': { type: 'string' },
      relayer: { type: 'boolean' },
      'relayer-host': { type: 'string' },
      'relayer-port': { type: 'string' },
      'relayer-account': { type: 'string' },
      'relayer-fee-eth': { type: 'string' },
      'relayer-fee-usdg': { type: 'string' },
      'libp2p-relay': { type: 'boolean' },
      'libp2p-relay-host': { type: 'string' },
      'libp2p-relay-port': { type: 'string' },
      shell: { type: 'boolean' },
      tick: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const source = values.phrase ? 'phrase' : values['private-key'] ? 'private-key' : values['import-file'] ? 'import-file' : null;
  return ConfigSchema.parse({
    command: values.help ? 'help' : (positionals[0] ?? 'help'),
    dataDir: values['data-dir'] ?? join(homedir(), '.occulta'),
    logLevel: values['log-level'] ?? 'info',
    init: { source, importFile: values['import-file'] },
    network: values.network,
    networkFile: values['network-file'],
    libp2pRelays: list(values['libp2p-relays']),
    relayers: list(values.relayers),
    maxFee: { eth: values['max-fee-eth'], usdg: values['max-fee-usdg'] },
    rpc: { enabled: values.rpc ?? false, port: values['rpc-port'] ?? 8645, tokenFile: values['rpc-token-file'] ?? join(homedir(), '.config', 'occulta', 'rpc.json') },
    relayer: {
      enabled: values.relayer ?? false,
      host: values['relayer-host'] ?? '0.0.0.0',
      port: values['relayer-port'] ?? 8646,
      account: values['relayer-account'],
      feeEth: values['relayer-fee-eth'],
      feeUsdg: values['relayer-fee-usdg'],
    },
    libp2pRelay: { enabled: values['libp2p-relay'] ?? false, host: values['libp2p-relay-host'] ?? '0.0.0.0', port: values['libp2p-relay-port'] ?? 8647 },
    shell: values.shell ?? true,
    tickSeconds: values.tick ?? 15,
  });
}
