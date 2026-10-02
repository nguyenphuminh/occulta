import type { z } from 'zod';
import { AppError } from '@occulta/framework';
import {
  channelSchema,
  depositSchema,
  emptySchema,
  exportSchema,
  importAccountSchema,
  openChannelSchema,
  payChannelSchema,
  sendPublicSchema,
  transferSchema,
  useAccountSchema,
  useNetworkSchema,
  withdrawSchema,
} from './node.schema.ts';
import type { NodeService } from './node.service.ts';

/** One operation, reachable as a shell command (positional arguments) and as `POST /rpc/<name>` (JSON). */
export interface Command {
  name: string;
  /** Names of the shell's positional arguments, in order; they become the JSON input's fields. */
  args: readonly string[];
  summary: string;
  schema: z.ZodType;
  run: (node: NodeService, input: never) => Promise<unknown> | unknown;
}

function command<S extends z.ZodType>(c: { name: string; args: readonly string[]; summary: string; schema: S; run: (node: NodeService, input: z.output<S>) => Promise<unknown> | unknown }): Command {
  return c as Command;
}

export const COMMANDS: readonly Command[] = [
  command({ name: 'status', args: [], summary: 'Active account, network, shielded address and balance', schema: emptySchema, run: (n) => n.getStatus() }),
  command({ name: 'accounts', args: [], summary: 'List the wallet’s accounts', schema: emptySchema, run: (n) => n.listAccounts() }),
  command({ name: 'account.add', args: [], summary: 'Derive the next account from the recovery phrase', schema: emptySchema, run: (n) => n.createAccount() }),
  command({ name: 'account.import', args: ['privateKey'], summary: 'Add an account from a private key', schema: importAccountSchema, run: (n, i) => n.importAccount(i.privateKey) }),
  command({ name: 'account.use', args: ['account'], summary: 'Switch the active account', schema: useAccountSchema, run: (n, i) => n.useAccount(i.account) }),
  command({ name: 'networks', args: [], summary: 'List the networks', schema: emptySchema, run: (n) => n.listNetworks() }),
  command({ name: 'network.use', args: ['network'], summary: 'Switch network', schema: useNetworkSchema, run: (n, i) => n.useNetwork(i.network) }),
  command({ name: 'public.balance', args: [], summary: 'Public ETH and USDG of the active account', schema: emptySchema, run: (n) => n.getPublicBalances() }),
  command({ name: 'public.send', args: ['token', 'to', 'amount'], summary: 'Send ETH or USDG publicly', schema: sendPublicSchema, run: (n, i) => n.sendPublic(i) }),
  command({ name: 'address', args: [], summary: 'Shielded address to get paid privately', schema: emptySchema, run: (n) => n.getShieldedAddress() }),
  command({ name: 'balance', args: [], summary: 'Sync and show the shielded balance', schema: emptySchema, run: (n) => n.getBalance() }),
  command({ name: 'notes', args: [], summary: 'Unspent notes', schema: emptySchema, run: (n) => n.listNotes() }),
  command({ name: 'deposit', args: ['token', 'amount'], summary: 'Move public funds into the pool', schema: depositSchema, run: (n, i) => n.deposit(i) }),
  command({ name: 'transfer', args: ['to', 'token', 'amount'], summary: 'Pay a shielded address privately', schema: transferSchema, run: (n, i) => n.transfer(i) }),
  command({ name: 'withdraw', args: ['token', 'amount', 'to'], summary: 'Take funds out of the pool (default: to a new account)', schema: withdrawSchema, run: (n, i) => n.withdraw(i) }),
  command({ name: 'invite', args: [], summary: 'Create an invite for a channel', schema: emptySchema, run: (n) => n.createInvite() }),
  command({ name: 'channels', args: [], summary: 'List channels', schema: emptySchema, run: (n) => n.listChannels() }),
  command({ name: 'channel.open', args: ['invite', 'token', 'amount', 'peerAmount', 'window'], summary: 'Open and fund a channel with an invite', schema: openChannelSchema, run: (n, i) => n.openChannel(i) }),
  command({ name: 'channel.pay', args: ['channel', 'amount'], summary: 'Pay in a channel', schema: payChannelSchema, run: (n, i) => n.payChannel(i) }),
  command({ name: 'channel.close', args: ['channel'], summary: 'Close a channel cooperatively', schema: channelSchema, run: (n, i) => n.closeChannel(i.channel) }),
  command({ name: 'dispute.start', args: ['channel'], summary: 'Close a channel unilaterally', schema: channelSchema, run: (n, i) => n.startDispute(i.channel) }),
  command({ name: 'tick', args: [], summary: 'Sync and move channels and disputes forward now', schema: emptySchema, run: (n) => n.tick() }),
  command({ name: 'export', args: ['path'], summary: 'Write the encrypted export file', schema: exportSchema, run: (n, i) => n.exportWallet(i.path) }),
  command({ name: 'relayer.info', args: [], summary: 'The transaction relayer this node uses and its fees', schema: emptySchema, run: (n) => n.getRelayerInfo() }),
];

export function findCommand(name: string): Command {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new AppError(404, 'UNKNOWN_COMMAND', `Unknown command "${name}"`);
  return found;
}

/** Validates the input and runs the command. */
export async function runCommand(node: NodeService, name: string, input: unknown): Promise<unknown> {
  const command = findCommand(name);
  return command.run(node, command.schema.parse(input) as never);
}
