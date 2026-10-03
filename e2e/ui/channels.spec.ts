// BRD 2.2.6–2.2.10 and 2.2.14.6–2.2.14.8 in the browser: invite link or pasted code, opening in ETH or USDG,
// payments confirmed in the wallet's dialog, a locked receiver, cooperative close, approving,
// declining or ignoring a channel that asks for funds while the opener goes on using the wallet,
// starting a dispute, peer nicknames, and a restored export.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  card,
  channelView,
  confirmRelayed,
  createInvite as invite,
  createWallet,
  fundPublicly,
  openAction,
  openChannel,
  openChannels,
  openDialog,
  openSettings,
  openWallet,
  payInChannel as pay,
  popup,
  profiled,
  recordConsole,
  unlock,
  useDevNetwork,
} from './helpers.ts';

async function userWithShieldedEth(browser: Browser, eth: '0.1' | '1'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  recordConsole(page, `user-${eth}-${Math.random().toString(36).slice(2, 6)}`);
  await createWallet(page);
  await useDevNetwork(page);
  await fundPublicly(page, '1');
  await openAction(page, 'Deposit');
  const deposit = popup(page, 'Deposit');
  await deposit.getByRole('button', { name: eth, exact: true }).click();
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(page.getByTestId('shielded-eth')).toHaveText(`${eth} ETH`);
  return page;
}

test('a channel from an invite link: open with a nickname, pay both ways with confirmation, rename, close', async ({ browser }) => {
  const alice = await userWithShieldedEth(browser, '0.1');
  const bob = await (await browser.newContext()).newPage();
  recordConsole(bob, 'bob');
  await createWallet(bob);
  await useDevNetwork(bob);

  const link = await invite(bob);
  await alice.goto(link);
  const open = openDialog(alice); // over the channel list
  await expect(open.getByLabel('Invite link or code', { exact: true })).toHaveValue(link.split('/invite/')[1] as string);
  await expect(open.getByText('Dispute window: 7 days')).toBeVisible();
  await open.getByLabel('Nickname (optional)', { exact: true }).fill('Bob');
  await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.05');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await profiled(alice, () => confirmRelayed(alice, 'Open channel'));
  await expect(open).toBeHidden();

  const aliceChannel = channelView(alice); // the opener lands on the new channel
  const bobChannel = await openChannel(bob);
  await expect(aliceChannel).toContainText('Live');
  await expect(bobChannel).toContainText('Live');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0499 ETH');
  await expect(aliceChannel.getByRole('heading', { level: 2 })).toContainText('Bob');
  await expect(alice.getByTestId('channel-item').first()).toContainText('Bob');
  await expect(bobChannel.getByRole('heading', { level: 2 })).toContainText(/Peer [A-Za-z0-9]{6}/); // Bob named nobody yet

  // Bob names Alice later, from the channel's header; nicknames never leave each wallet.
  await bobChannel.getByRole('button', { name: 'Add a nickname' }).click();
  await bobChannel.getByLabel('Nickname', { exact: true }).fill('Alice');
  await bobChannel.getByRole('button', { name: 'Save' }).click();
  await expect(bobChannel.getByRole('heading', { level: 2 })).toContainText('Alice');
  await expect(aliceChannel.getByRole('heading', { level: 2 })).not.toContainText('Alice');

  await pay(alice, aliceChannel, '0.01', true);
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0399 ETH');
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.01 ETH');

  // Without the user's confirmation, nothing is signed.
  await pay(alice, aliceChannel, '0.005', false);
  await expect(aliceChannel.getByRole('alert')).toHaveText('The payment was not confirmed');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0399 ETH');

  await pay(bob, bobChannel, '0.002', true);
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.008 ETH');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0419 ETH');

  // Alice renames Bob; the list follows.
  await aliceChannel.getByRole('button', { name: 'Rename' }).click();
  await expect(aliceChannel.getByLabel('Nickname', { exact: true })).toHaveValue('Bob');
  await aliceChannel.getByLabel('Nickname', { exact: true }).fill('Bob from work');
  await aliceChannel.getByRole('button', { name: 'Save' }).click();
  await expect(aliceChannel.getByRole('heading', { level: 2 })).toContainText('Bob from work');
  await expect(alice.getByTestId('channel-item').first()).toContainText('Bob from work');

  await aliceChannel.getByRole('button', { name: 'Close channel' }).click();
  await confirmRelayed(alice, 'Close channel');
  await expect(aliceChannel).toContainText('Closed');
  await expect(bobChannel).toContainText('Closed');
  await openWallet(bob);
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.008 ETH');
});

test('a channel that asks the invitee to fund needs approval; a dispute can be started', async ({ browser }) => {
  const [alice, bob] = await Promise.all([userWithShieldedEth(browser, '0.1'), userWithShieldedEth(browser, '0.1')]);

  // Bob declines the first request, then accepts the second. Alice never waits on his answer.
  for (const accept of [false, true]) {
    const link = await invite(bob);
    await alice.goto(link);
    const open = openDialog(alice);
    await open.getByLabel('Nickname (optional)', { exact: true }).fill('Bob');
    await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.03');
    await open.getByLabel('Ask the other side to fund (ETH, optional)', { exact: true }).fill('0.02');
    await open.getByRole('button', { name: 'Open channel' }).click();
    await confirmRelayed(alice, 'Open channel'); // closes at once
    await expect(open).toBeHidden();
    const request = bob.getByRole('dialog', { name: 'Channel request' });
    await expect(request).toContainText('They fund 0.03 ETH and ask you to fund 0.02 ETH');
    await expect(request).toContainText(/\d+ s left to answer/);
    // Bob puts the request aside and answers it from his channel list.
    await request.getByRole('button', { name: 'Close' }).click();
    await expect(request).toBeHidden();
    await openChannels(bob);
    await expect(bob.getByTestId('channel-item').first()).toContainText('Request');
    await bob.getByTestId('channel-item').first().click();
    const incoming = bob.getByTestId('channel-request');
    await expect(incoming).toContainText('They fund 0.03 ETH and ask you to fund 0.02 ETH');
    await expect(incoming).toContainText(/\d+ s left to answer/);
    const waiting = alice.getByTestId('pending-open');
    await expect(waiting).toContainText('Waiting for Bob to accept');
    await expect(waiting.getByRole('heading', { level: 2 })).toHaveText('Bob');
    await expect(alice.getByTestId('channel-item')).toHaveCount(1);
    await expect(alice.getByTestId('channel-item').first()).toContainText('Pending');

    if (!accept) {
      // Meanwhile Alice uses the rest of the wallet; nothing has left her balance.
      await openAction(alice, 'Receive');
      await popup(alice, 'Receive').getByRole('button', { name: 'Close' }).click();
      await expect(alice.getByTestId('shielded-eth')).toHaveText('0.1 ETH');
      await incoming.getByRole('button', { name: 'Decline' }).click();
      await expect(bob.getByText('This channel request ended: it was declined or not answered in time.')).toBeVisible();
      await expect(bob.getByTestId('channel-item')).toHaveCount(0);
      await openChannels(alice);
      const declined = alice.getByTestId('channel-item').first();
      await expect(declined).toContainText('Declined');
      await declined.click();
      await expect(waiting).toContainText('Bob declined, or did not answer in time');
      await expect(waiting).toContainText('Nothing left your shielded balance');
      await waiting.getByRole('button', { name: 'Dismiss' }).click();
      await expect(alice.getByTestId('channel-item')).toHaveCount(0);
      await expect(alice).toHaveURL(/#\/channels$/);
    } else {
      await incoming.getByLabel('Nickname for them (optional)', { exact: true }).fill('Alice');
      await incoming.getByRole('button', { name: 'Accept and fund' }).click();
      // Bob's request becomes the channel in place, listed once.
      await expect(channelView(bob).getByRole('heading', { level: 2 })).toHaveText('Alice');
      await expect(incoming).toBeHidden();
      await expect(bob.getByTestId('channel-item')).toHaveCount(1);
      // Alice was looking at the request: she follows it to the channel, listed once.
      await expect(alice).toHaveURL(/#\/channels\/[0-9a-f]{32}$/);
      await expect(waiting).toBeHidden();
      await expect(alice.getByTestId('channel-item')).toHaveCount(1);
    }
  }

  // Bob funds his side on his own once Alice's contribution is in the pool.
  const aliceChannel = channelView(alice);
  const bobChannel = await openChannel(bob);
  await expect(bobChannel).toContainText('Live', { timeout: 120_000 });
  await expect(aliceChannel).toContainText('Live');
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.02 ETH');
  await expect(bobChannel.getByRole('heading', { level: 2 })).toContainText('Alice'); // named when accepting

  await bobChannel.getByRole('button', { name: 'Close without the other side' }).click();
  const confirm = bob.getByRole('dialog', { name: 'Close without the other side' });
  await expect(confirm).toContainText('7-day window');
  await confirm.getByRole('button', { name: 'Start dispute' }).click();
  await expect(bobChannel).toContainText('In dispute');
  await expect(aliceChannel).toContainText('In dispute');
});

test('a USDG channel from a pasted invite code; a locked wallet signs nothing until it is unlocked', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await createWallet(alice);
  await useDevNetwork(alice);
  await fundPublicly(alice, '1', '100');
  await openAction(alice, 'Deposit');
  const deposit = popup(alice, 'Deposit');
  await deposit.getByLabel('Token', { exact: true }).selectOption('usdg');
  await deposit.getByRole('button', { name: '10', exact: true }).click();
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('10 USDG');

  const bob = await (await browser.newContext()).newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  const link = await invite(bob);
  await openChannels(alice);
  await alice.getByRole('link', { name: 'Open channel', exact: true }).click();
  const open = openDialog(alice);
  await expect(open.getByLabel('Invite link or code', { exact: true })).toHaveValue('');
  await open.getByLabel('Invite link or code', { exact: true }).fill(link.split('/invite/')[1] as string);
  await open.getByLabel('Token', { exact: true }).selectOption('usdg');
  await open.getByLabel('You fund (USDG)', { exact: true }).fill('5');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await confirmRelayed(alice, 'Open channel', '0.01 USDG');
  const aliceChannel = channelView(alice);
  const bobChannel = await openChannel(bob);
  await expect(aliceChannel).toContainText('Live');
  await expect(bobChannel).toContainText('Live');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('4.99 USDG');
  await pay(alice, aliceChannel, '1', true, 'USDG');
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('1 USDG');

  // Bob locks his wallet: Alice's next payment is not signed, and is sent first once he is back.
  await bob.getByRole('button', { name: 'Lock' }).click();
  await pay(alice, aliceChannel, '0.5', true, 'USDG');
  await expect(aliceChannel.getByRole('alert')).toHaveText('The other party is not reachable right now');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('3.99 USDG');
  await unlock(bob);
  await invite(bob); // reachable again
  await openChannel(bob);
  await pay(alice, aliceChannel, '0.25', true, 'USDG');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('3.24 USDG');
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('1.75 USDG');

  await aliceChannel.getByRole('button', { name: 'Close channel' }).click();
  await confirmRelayed(alice, 'Close channel', '0.01 USDG');
  await expect(aliceChannel).toContainText('Closed');
  await expect(bobChannel).toContainText('Closed');
  await openWallet(bob);
  await expect(bob.getByTestId('shielded-usdg')).toHaveText('1.75 USDG');
});

test('a channel request nobody answers counts as declined', async ({ browser }) => {
  const alice = await userWithShieldedEth(browser, '0.1');
  const bob = await (await browser.newContext()).newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  await alice.goto(await invite(bob));
  const open = openDialog(alice);
  await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.02');
  await open.getByLabel('Ask the other side to fund (ETH, optional)', { exact: true }).fill('0.01');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await confirmRelayed(alice, 'Open channel');
  const request = bob.getByRole('dialog', { name: 'Channel request' });
  await expect(request).toBeVisible();
  // Bob closes the request and leaves it: after about a minute it counts as declined.
  await request.getByRole('button', { name: 'Close' }).click();
  await openChannels(bob);
  await bob.getByTestId('channel-item').first().click();
  await expect(bob.getByTestId('channel-request')).toContainText(/\d+ s left to answer/);
  const waiting = alice.getByTestId('pending-open');
  await expect(waiting).toContainText('Waiting for');
  await expect(waiting).toContainText('declined, or did not answer in time', { timeout: 75_000 });
  await expect(alice.getByTestId('channel-item').first()).toContainText('Declined');
  await expect(bob.getByText('This channel request ended: it was declined or not answered in time.')).toBeVisible();
  await expect(bob.getByTestId('channel-item')).toHaveCount(0);
  // It stays until dismissed.
  await openChannels(alice);
  await expect(alice.getByTestId('channel-item')).toHaveCount(1);
  await alice.getByTestId('channel-item').first().click();
  await waiting.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alice.getByTestId('channel-item')).toHaveCount(0);
});

test('a restored export keeps its notes, nicknames and a live channel, which can still be paid and closed', async ({ browser }) => {
  const alice = await userWithShieldedEth(browser, '0.1');
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  await alice.goto(await invite(bob));
  const open = openDialog(alice);
  await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.03');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await confirmRelayed(alice, 'Open channel');
  const aliceChannel = channelView(alice);
  const bobChannel = await openChannel(bob);
  await expect(bobChannel).toContainText('Live');
  await expect(aliceChannel).toContainText('Live');
  await pay(alice, aliceChannel, '0.01', true);
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.01 ETH');
  await bobChannel.getByRole('button', { name: 'Add a nickname' }).click();
  await bobChannel.getByLabel('Nickname', { exact: true }).fill('Alice');
  await bobChannel.getByRole('button', { name: 'Save' }).click();
  await expect(bobChannel.getByRole('heading', { level: 2 })).toHaveText('Alice');

  // Bob exports and continues in a fresh browser; the old one is gone.
  await openSettings(bob, 'Backup');
  const downloading = bob.waitForEvent('download');
  await card(bob, 'Export').getByRole('button', { name: 'Download export file' }).click();
  const file = join(tmpdir(), `occulta-export-${Date.now()}.json`);
  await (await downloading).saveAs(file);
  await bobContext.close();
  const restored = await (await browser.newContext()).newPage();
  await restored.goto('/');
  await restored.getByRole('button', { name: 'Restore from an export file' }).click();
  await restored.getByLabel('Export file', { exact: true }).setInputFiles(file);
  await restored.getByLabel('Password of the export file', { exact: true }).fill('correct horse battery');
  await restored.getByRole('button', { name: 'Restore' }).click();
  await expect(restored.getByRole('button', { name: 'Lock' })).toBeVisible();
  await invite(restored); // reachable again
  const channel = await openChannel(restored);
  await expect(channel).toContainText('Live');
  await expect(channel.getByTestId('channel-mine')).toHaveText('0.01 ETH');
  await expect(channel.getByRole('heading', { level: 2 })).toHaveText('Alice'); // the nickname came with the export

  await pay(alice, aliceChannel, '0.002', true);
  await expect(channel.getByTestId('channel-mine')).toHaveText('0.012 ETH');
  await channel.getByRole('button', { name: 'Close channel' }).click();
  await confirmRelayed(restored, 'Close channel');
  await expect(channel).toContainText('Closed');
  await expect(aliceChannel).toContainText('Closed');
  await openWallet(restored);
  await expect(restored.getByTestId('shielded-eth')).toHaveText('0.012 ETH');
});
