// BRD 2.2.6–2.2.10 in the browser: invite link, opening, payments confirmed in the wallet's dialog,
// cooperative close, approving or declining a channel that asks for funds, and starting a dispute.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { card, confirmRelayed, createWallet, fundPublicly, profiled, recordConsole, useDevNetwork } from './helpers.ts';

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

async function invite(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Channels' }).click();
  await card(page, 'Invite someone').getByRole('button', { name: 'Create invite' }).click();
  const link = (await page.getByTestId('invite-link').textContent()) as string;
  expect(link).toMatch(/\/#\/invite\/[A-Za-z0-9_-]+$/);
  return link;
}

async function pay(page: Page, channel: ReturnType<Page['locator']>, amount: string, confirm: boolean): Promise<void> {
  await channel.getByLabel('Pay (ETH)', { exact: true }).fill(amount);
  await channel.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm payment' });
  await expect(dialog).toContainText(`Pay ${amount} ETH`);
  await dialog.getByRole('button', { name: confirm ? 'Confirm payment' : 'Cancel' }).click();
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
