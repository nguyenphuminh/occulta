import { writeFile } from 'node:fs/promises';
import {
  AppError,
  balanceOf,
  decodeInvite,
  encodeInvite,
  shieldedAddressOf,
  sideOf,
  type Account,
  type ChannelRecord,
  type Occulta,
} from '@occulta/framework';
import { formatAmount, parseAmount, tokenId, tokenName, type TokenName } from '../../shared/utils/amounts.ts';
import type { DepositInput, OpenChannelInput, PayChannelInput, TransferInput, WithdrawInput } from './node.schema.ts';

export interface NodeOptions {
  /** The relayer role's account (BRD 2.2.15): it never makes deposits. */
  relayerAccountId?: string;
  /** What the node's other roles expose (relayer URL, libp2p relay addresses), for `status`. */
  roles: () => Record<string, unknown>;
}

/**
 * Everything the user drives through the shell and local apps through RPC (BRD 2.2.15): the same
 * operations as the wallet website, on the framework, with amounts in ETH and USDG units.
 */
export class NodeService {
  private readonly occulta: Occulta;
  private readonly options: NodeOptions;

  constructor(occulta: Occulta, options: NodeOptions) {
    this.occulta = occulta;
    this.options = options;
  }

  async getStatus() {
    const { wallet } = this.occulta;
    const account = wallet.activeAccount();
    const network = this.occulta.network();
    return {
      account: this.describeAccount(account),
      network: { id: network.id, name: network.name, deployed: Boolean(network.contracts) },
      shieldedAddress: await this.getShieldedAddress(),
      shieldedBalance: this.formatBalances(this.occulta.pool.balances()),
      lastExportAt: wallet.lastExportAt() === null ? null : new Date(wallet.lastExportAt() as number).toISOString(),
      roles: this.options.roles(),
    };
  }

  // --- accounts and networks ---

  listAccounts() {
    return this.occulta.wallet.accounts().map((a) => this.describeAccount(a));
  }

  async createAccount() {
    return this.describeAccount(await this.occulta.wallet.addAccount());
  }

  async importAccount(privateKey: string) {
    return this.describeAccount(await this.occulta.wallet.importAccount(privateKey));
  }

  async useAccount(id: string) {
    await this.occulta.wallet.setActiveAccount(this.findAccount(id).id);
    await this.occulta.start();
    return this.describeAccount(this.occulta.wallet.activeAccount());
  }

  listNetworks() {
    const active = this.occulta.wallet.networkId();
    return this.occulta.networks().map((n) => ({ id: n.id, name: n.name, chainId: n.chainId, deployed: Boolean(n.contracts), active: n.id === active }));
  }

  async useNetwork(id: string) {
    if (!this.occulta.networks().some((n) => n.id === id)) throw new AppError(404, 'UNKNOWN_NETWORK', `No network "${id}"`);
    await this.occulta.wallet.setNetwork(id);
    await this.occulta.start();
    return { network: id };
  }

  // --- public funds (BRD 2.2.14.4) ---

  async getPublicBalances() {
    const { chain, wallet } = this.occulta;
    const { address } = wallet.activeAccount();
    return {
      address,
      eth: formatAmount('eth', await chain.publicBalance(address, 0n)),
      usdg: formatAmount('usdg', await chain.publicBalance(address, tokenId('usdg', chain.network))),
    };
  }

  // --- shielded pool (BRD 2.2.2–2.2.5) ---

  async getShieldedAddress() {
    return shieldedAddressOf(await this.occulta.keys.poolKeys());
  }

  async getBalance() {
    await this.occulta.pool.sync();
    return this.formatBalances(this.occulta.pool.balances());
  }

  listNotes() {
    const network = this.occulta.network();
    return this.occulta.pool
      .notes()
      .filter((n) => !n.spent)
      .map((n) => ({ amount: formatAmount(tokenName(n.token, network), n.amount), leafIndex: n.leafIndex, channel: n.secret === 'spending' ? null : n.secret.channel }));
  }

  async deposit(input: DepositInput) {
    this.ownAccount();
    const network = this.occulta.network();
    return { txHash: await this.occulta.pool.deposit(tokenId(input.token, network), parseAmount(input.token, input.amount)) };
  }

  async transfer(input: TransferInput) {
    const network = this.occulta.network();
    return { txHash: await this.occulta.pool.transfer(input.to, tokenId(input.token, network), parseAmount(input.token, input.amount), this.occulta.relayer()) };
  }

  async withdraw(input: WithdrawInput) {
    const network = this.occulta.network();
    const to = input.to ?? (await this.freshExitAccount()).address;
    const txHash = await this.occulta.pool.withdraw(tokenId(input.token, network), parseAmount(input.token, input.amount), to, this.occulta.relayer());
    return { txHash, to };
  }

  // --- channels and disputes (BRD 2.2.6–2.2.10) ---

  async createInvite() {
    return { invite: encodeInvite(this.occulta.p2p.invite(await this.getShieldedAddress())) };
  }

  async openChannel(input: OpenChannelInput) {
    const network = this.occulta.network();
    const record = await this.occulta.channels.open(decodeInvite(input.invite), {
      token: tokenId(input.token, network),
      amount: parseAmount(input.token, input.amount),
      peerAmount: input.peerAmount === undefined ? 0n : parseAmount(input.token, input.peerAmount),
      window: input.window === undefined ? undefined : BigInt(input.window),
      relayer: this.occulta.relayer(),
    });
    return this.describeChannel(record);
  }

  listChannels() {
    return this.occulta.channels.list().map((r) => this.describeChannel(r));
  }

  async payChannel(input: PayChannelInput) {
    const { token } = this.occulta.channels.get(input.channel);
    const record = await this.occulta.channels.pay(input.channel, parseAmount(tokenName(token, this.occulta.network()), input.amount));
    return this.describeChannel(record);
  }

  async closeChannel(id: string) {
    return this.describeChannel(await this.occulta.channels.close(id, this.occulta.relayer()));
  }

  /** BRD 2.2.7: cancels an opening nobody funded. */
  async cancelChannel(id: string) {
    return this.describeChannel(await this.occulta.channels.cancel(id));
  }

  async startDispute(id: string) {
    return { txHash: await this.occulta.disputes.start(id, this.occulta.relayer()) };
  }

  /** Runs the background work now: note sync, channel progress, dispute watching. */
  async tick() {
    return (await this.occulta.tick()).map((p) => ({ channel: p.channelId, error: p.error instanceof Error ? p.error.message : String(p.error) }));
  }

  // --- export (BRD 2.2.14.6) and relayers ---

  async exportWallet(path: string) {
    await writeFile(path, await this.occulta.wallet.exportFile(), { mode: 0o600 });
    return { path, exportedAt: new Date(this.occulta.wallet.lastExportAt() as number).toISOString() };
  }

  async getRelayerInfo() {
    return this.occulta.relayer().info();
  }

  // --- helpers ---

  /** The active account, refusing the relayer account: it never makes deposits. */
  private ownAccount(): Account {
    const account = this.occulta.wallet.activeAccount();
    if (account.id === this.options.relayerAccountId) {
      throw new AppError(409, 'RELAYER_ACCOUNT', 'The relayer account never makes deposits; switch to another account');
    }
    return account;
  }

  /** A never-used account other than the active one and the relayer account, created if needed. */
  private async freshExitAccount(): Promise<Account> {
    const { wallet } = this.occulta;
    const active = wallet.activeAccount().id;
    return wallet.accounts().find((a) => !a.used && a.id !== active && a.id !== this.options.relayerAccountId) ?? wallet.addAccount();
  }

  private findAccount(idOrAddress: string): Account {
    const account = this.occulta.wallet.accounts().find((a) => a.id.toLowerCase() === idOrAddress.toLowerCase());
    if (!account) throw new AppError(404, 'UNKNOWN_ACCOUNT', `No account ${idOrAddress} in this wallet`);
    return account;
  }

  private describeAccount(a: Account) {
    const { wallet } = this.occulta;
    return { id: a.id, label: a.label, kind: a.kind, used: a.used, active: a.id === wallet.activeAccount().id, relayer: a.id === this.options.relayerAccountId };
  }

  private describeChannel(r: ChannelRecord) {
    const name: TokenName = tokenName(r.token, this.occulta.network());
    const s = r.latest.state;
    const me = sideOf(r);
    return {
      id: r.id,
      status: r.status,
      role: r.role === 'A' ? 'opener' : 'invitee',
      balance: formatAmount(name, balanceOf(s, me)),
      peerBalance: formatAmount(name, balanceOf(s, me === 0 ? 1 : 0)),
      closingFee: formatAmount(name, s.closingFee),
      windowSeconds: Number(r.params.window),
      peer: r.peer.peerId,
    };
  }

  private formatBalances(balances: Map<bigint, bigint>) {
    const network = this.occulta.network();
    return { eth: formatAmount('eth', balances.get(0n) ?? 0n), usdg: formatAmount('usdg', balances.get(tokenId('usdg', network)) ?? 0n) };
  }
}
