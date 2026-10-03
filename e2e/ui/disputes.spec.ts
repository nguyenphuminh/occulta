// BRD 2.2.10 in the browser, against a counterparty that cheats. The website always opens channels
// with the 7-day window, so the other side is a framework node in this test process that opens a
// channel with a 20-second window (the dev-node contracts accept windows from 10 s) and then submits
// an old state.
import { expect, test } from '@playwright/test';
import { parseEther } from 'viem';
import { ChainAdapter, NetworkConfigSchema } from '../../packages/framework/src/modules/chain/index.ts';
import { decodeInvite } from '../../packages/framework/src/modules/p2p/index.ts';
import { HttpRelayer } from '../../packages/framework/src/modules/relayer/index.ts';
import { channelNullifierOf } from '../../packages/framework/src/shared/protocol/index.ts';
import { mineBlock } from '../integration/chain.ts';
import { newChannelNode, newUser, type ChannelNode } from '../integration/services.ts';
import { createInvite, createWallet, devSend, fundPublicly, openWallet, openAction, openChannel, popup, unlock, useDevNetwork } from './helpers.ts';

const WINDOW = 20n;
const ETH = 0n;
let chain: ChainAdapter;
let relayer: HttpRelayer;
let alice: ChannelNode;

test.beforeAll(async () => {
  const network = NetworkConfigSchema.parse(JSON.parse(process.env.OCCULTA_UI_NETWORK as string));
  chain = new ChainAdapter(network);
  relayer = new HttpRelayer(network.relayers[0] as string);
  const user = await devSend(() => newUser(network, chain, '1'));
  await user.pool.deposit(ETH, parseEther('0.1'));
  alice = await newChannelNode(user, chain, network.libp2pRelays[0] as string);
});

test.afterAll(async () => {
  await alice?.p2p.stop();
});

/** Alice's app "forgets" every later state and disputes with state 0. */
async function cheatWithStateZero(id: string): Promise<void> {
  await alice.channels.update(id, async (r) => {
    r.latest = { ...r.state0 };
  });
  await alice.disputes.start(id, relayer);
}

/** Waits past the deadline (the dev node's clock moves only when a block is mined). */
async function passDeadline(): Promise<void> {
  await new Promise((r) => setTimeout(r, Number(WINDOW) * 1000 + 1500));
  await devSend(() => mineBlock());
}

test('scenario B: the open wallet answers an old state, finalizes after the deadline and keeps what it was owed', async ({ browser }) => {
  const bob = await (await browser.newContext()).newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  const opened = await alice.channels.open(decodeInvite(await createInvite(bob)), { token: ETH, amount: parseEther('0.02'), window: WINDOW, relayer });
  const channel = await openChannel(bob);
  await expect(channel).toContainText('Live');
  expect(await alice.channels.tick(relayer)).toEqual([]);
  await alice.channels.pay(opened.id, parseEther('0.01'));
  await expect(channel.getByTestId('channel-mine')).toHaveText('0.01 ETH');

  await cheatWithStateZero(opened.id);
  await expect(channel).toContainText('In dispute');
  const record = alice.channels.get(opened.id);
  const latestNonce = record.history.at(-1)?.[3];
  // Bob's wallet replaced Alice's old state with the latest one on its own.
  await expect.poll(async () => (await chain.disputeOf(channelNullifierOf(record.params.channelSecret))).nonce, { timeout: 60_000 }).toBe(latestNonce);

  await passDeadline();
  await expect(channel).toContainText('Settled', { timeout: 120_000 });
  await openWallet(bob);
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.01 ETH');
  expect(await alice.disputes.tick(relayer)).toEqual([]);
  expect(alice.channels.get(opened.id).status).toBe('settled');
});

test('scenario C: a wallet closed for the whole window reclaims its contribution when it comes back', async ({ browser }) => {
  const bob = await (await browser.newContext()).newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  await fundPublicly(bob, '1');
  await openAction(bob, 'Deposit');
  await popup(bob, 'Deposit').getByRole('button', { name: '0.1', exact: true }).click();
  await popup(bob, 'Deposit').getByRole('button', { name: 'Deposit' }).click();
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.1 ETH');

  const opening = alice.channels.open(decodeInvite(await createInvite(bob)), { token: ETH, amount: parseEther('0.02'), peerAmount: parseEther('0.01'), window: WINDOW, relayer });
  await bob.getByRole('dialog', { name: 'Channel request' }).getByRole('button', { name: 'Accept and fund' }).click();
  const opened = await opening;
  const channel = await openChannel(bob);
  await expect(channel).toContainText('Live', { timeout: 120_000 }); // Bob funded his side on his own
  expect(await alice.channels.tick(relayer)).toEqual([]);
  expect(alice.channels.get(opened.id).status).toBe('live');
  await alice.channels.pay(opened.id, parseEther('0.005'));
  await expect(channel.getByTestId('channel-mine')).toHaveText('0.015 ETH');

  // Bob closes the website. Alice disputes with state 0 and settles it after the deadline.
  await bob.goto('about:blank');
  await cheatWithStateZero(opened.id);
  await passDeadline();
  expect(await alice.disputes.tick(relayer)).toEqual([]);
  expect(alice.channels.get(opened.id).status).toBe('settled');

  // Bob comes back: what Alice had paid him is lost (BRD scenario C), his contribution comes back.
  await bob.goto('/');
  await unlock(bob);
  await expect(await openChannel(bob)).toContainText('Settled', { timeout: 120_000 });
  await openWallet(bob);
  // 0.1 − 0.01 contribution − 0.0001 funding fee + (0.01 − 0.0001 reclaim fee)
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.0998 ETH');
});
