// BRD 2.2.6–2.2.10 and 2.2.14.6 in the browser: invite link or pasted code, opening in ETH or USDG,
// payments confirmed in the wallet's dialog, a locked receiver, cooperative close, approving,
// declining or ignoring a channel that asks for funds, starting a dispute, and a restored export.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { card, confirmRelayed, createInvite as invite, createWallet, fundPublicly, payInChannel as pay, profiled, recordConsole, unlock, useDevNetwork } from './helpers.ts';

async function userWithShieldedEth(browser: Browser, eth: '0.1' | '1'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  recordConsole(page, `user-${eth}-${Math.random().toString(36).slice(2, 6)}`);
  await createWallet(page);
  await useDevNetwork(page);
  await fundPublicly(page, '1');
  await page.getByRole('link', { name: 'Shielded' }).click();
  const deposit = card(page, 'Deposit');
  await deposit.getByRole('button', { name: eth, exact: true }).click();
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(page.getByTestId('shielded-eth')).toHaveText(`${eth} ETH`);
  return page;
}

test('a channel from an invite link: open, pay both ways with confirmation, close', async ({ browser }) => {
  const alice = await userWithShieldedEth(browser, '0.1');
  const bob = await (await browser.newContext()).newPage();
  recordConsole(bob, 'bob');
  await createWallet(bob);
  await useDevNetwork(bob);

  const link = await invite(bob);
  await alice.goto(link);
  const open = card(alice, 'Open a channel');
  await expect(open.getByLabel('Invite link or code', { exact: true })).toHaveValue(link.split('/invite/')[1] as string);
  await expect(open.getByText('Dispute window: 7 days')).toBeVisible();
  await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.05');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await profiled(alice, () => confirmRelayed(alice, 'Open channel'));

  const aliceChannel = alice.locator('li.channel').first();
  const bobChannel = bob.locator('li.channel').first();
  await expect(aliceChannel).toContainText('Live');
  await expect(bobChannel).toContainText('Live');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0499 ETH');

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

  await aliceChannel.getByRole('button', { name: 'Close channel' }).click();
  await confirmRelayed(alice, 'Close channel');
  await expect(aliceChannel).toContainText('Closed');
  await expect(bobChannel).toContainText('Closed');
  await bob.getByRole('link', { name: 'Shielded' }).click();
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.008 ETH');
});

test('a channel that asks the invitee to fund needs approval; a dispute can be started', async ({ browser }) => {
  const [alice, bob] = await Promise.all([userWithShieldedEth(browser, '0.1'), userWithShieldedEth(browser, '0.1')]);

  // Bob declines the first request, then accepts the second.
  for (const accept of [false, true]) {
    const link = await invite(bob);
    await alice.goto(link);
    const open = card(alice, 'Open a channel');
    await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.03');
    await open.getByLabel('Ask the other side to fund (ETH, optional)', { exact: true }).fill('0.02');
    await open.getByRole('button', { name: 'Open channel' }).click();
    await alice.getByRole('dialog', { name: 'Confirm: Open channel' }).getByRole('button', { name: 'Confirm' }).click();
    const request = bob.getByRole('dialog', { name: 'Channel request' });
    await expect(request).toContainText('They fund 0.03 ETH and ask you to fund 0.02 ETH');
    await request.getByRole('button', { name: accept ? 'Accept and fund' : 'Decline' }).click();
    if (!accept) {
      await expect(alice.getByRole('dialog', { name: 'Confirm: Open channel' }).getByRole('alert')).toHaveText('The other party declined this channel');
      await alice.getByRole('dialog', { name: 'Confirm: Open channel' }).getByRole('button', { name: 'Cancel' }).click();
    } else {
      await expect(alice.getByRole('dialog', { name: 'Confirm: Open channel' })).toBeHidden({ timeout: 120_000 });
    }
  }

  // Bob funds his side on his own once Alice's contribution is in the pool.
  const aliceChannel = alice.locator('li.channel').first();
  const bobChannel = bob.locator('li.channel').first();
  await expect(bobChannel).toContainText('Live', { timeout: 120_000 });
  await expect(aliceChannel).toContainText('Live');
  await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.02 ETH');

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
  await alice.getByRole('link', { name: 'Shielded' }).click();
  const deposit = card(alice, 'Deposit');
  await deposit.getByLabel('Token', { exact: true }).selectOption('usdg');
  await deposit.getByRole('button', { name: '10', exact: true }).click();
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('10 USDG');

  const bob = await (await browser.newContext()).newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  const link = await invite(bob);
  await expect(card(bob, 'Invite someone').getByRole('img', { name: 'Invite QR code' })).toBeVisible();
  await alice.getByRole('link', { name: 'Channels' }).click();
  const open = card(alice, 'Open a channel');
  await open.getByLabel('Invite link or code', { exact: true }).fill(link.split('/invite/')[1] as string);
  await open.getByLabel('Token', { exact: true }).selectOption('usdg');
  await open.getByLabel('You fund (USDG)', { exact: true }).fill('5');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await confirmRelayed(alice, 'Open channel', '0.01 USDG');
  const aliceChannel = alice.locator('li.channel').first();
  const bobChannel = bob.locator('li.channel').first();
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
  await card(bob, 'Invite someone').getByRole('button', { name: 'Create invite' }).click(); // reachable again
  await expect(bob.getByTestId('invite-link')).toBeVisible();
  await pay(alice, aliceChannel, '0.25', true, 'USDG');
  await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('3.24 USDG');
  await expect(bob.locator('li.channel').first().getByTestId('channel-mine')).toHaveText('1.75 USDG');

  await aliceChannel.getByRole('button', { name: 'Close channel' }).click();
  await confirmRelayed(alice, 'Close channel', '0.01 USDG');
  await expect(aliceChannel).toContainText('Closed');
  await expect(bob.locator('li.channel').first()).toContainText('Closed');
  await bob.getByRole('link', { name: 'Shielded' }).click();
  await expect(bob.getByTestId('shielded-usdg')).toHaveText('1.75 USDG');
});

test('a channel request nobody answers counts as declined', async ({ browser }) => {
  const alice = await userWithShieldedEth(browser, '0.1');
  const bob = await (await browser.newContext()).newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  await alice.goto(await invite(bob));
  const open = card(alice, 'Open a channel');
  await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.02');
  await open.getByLabel('Ask the other side to fund (ETH, optional)', { exact: true }).fill('0.01');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await alice.getByRole('dialog', { name: 'Confirm: Open channel' }).getByRole('button', { name: 'Confirm' }).click();
  const request = bob.getByRole('dialog', { name: 'Channel request' });
  await expect(request).toBeVisible();
  await expect(alice.getByRole('dialog', { name: 'Confirm: Open channel' }).getByRole('alert')).toHaveText('The other party declined this channel', { timeout: 75_000 });
  await expect(request).toBeHidden();
  await expect(bob.locator('li.channel')).toHaveCount(0);
});

test('a restored export keeps its notes and a live channel, which can still be paid and closed', async ({ browser }) => {
  const alice = await userWithShieldedEth(browser, '0.1');
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await createWallet(bob);
  await useDevNetwork(bob);
  await alice.goto(await invite(bob));
  const open = card(alice, 'Open a channel');
  await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.03');
  await open.getByRole('button', { name: 'Open channel' }).click();
  await confirmRelayed(alice, 'Open channel');
  const aliceChannel = alice.locator('li.channel').first();
  await expect(bob.locator('li.channel').first()).toContainText('Live');
  await expect(aliceChannel).toContainText('Live');
  await pay(alice, aliceChannel, '0.01', true);
  await expect(bob.locator('li.channel').first().getByTestId('channel-mine')).toHaveText('0.01 ETH');

  // Bob exports and continues in a fresh browser; the old one is gone.
  await bob.getByRole('link', { name: 'Settings' }).click();
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
  await restored.getByRole('link', { name: 'Channels' }).click();
  const channel = restored.locator('li.channel').first();
  await expect(channel).toContainText('Live');
  await expect(channel.getByTestId('channel-mine')).toHaveText('0.01 ETH');
  await card(restored, 'Invite someone').getByRole('button', { name: 'Create invite' }).click(); // reachable again
  await expect(restored.getByTestId('invite-link')).toBeVisible();

  await pay(alice, aliceChannel, '0.002', true);
  await expect(channel.getByTestId('channel-mine')).toHaveText('0.012 ETH');
  await channel.getByRole('button', { name: 'Close channel' }).click();
  await confirmRelayed(restored, 'Close channel');
  await expect(channel).toContainText('Closed');
  await expect(aliceChannel).toContainText('Closed');
  await restored.getByRole('link', { name: 'Shielded' }).click();
  await expect(restored.getByTestId('shielded-eth')).toHaveText('0.012 ETH');
});
