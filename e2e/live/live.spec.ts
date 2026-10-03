// The live deployment (npm run deploy:live) from a user's side: https://occulta.space on Arbitrum
// Sepolia, its relayer and libp2p relay at relay.occulta.space. npm run test:live.
// Test money comes from ~/.occulta-secrets/funder.key and goes back to it at the end. A dispute can
// only be started here: finishing one takes the contracts' 3–7 day window, so the rest of the
// dispute flows is covered by the dev-chain UI tests.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mnemonicToAccount } from 'viem/accounts';
import { REPO } from '../../scripts/lib/devnode.ts';
import {
  PASSWORD,
  card,
  channelView,
  confirmRelayed,
  createInvite as invite,
  createWallet,
  openAction,
  openChannel,
  openChannels,
  openDialog,
  openSettings,
  openWallet,
  payInChannel as pay,
  phraseWords,
  popup,
  recordConsole,
  setPassword,
  unlock,
} from '../ui/helpers.ts';
import { client, fund, funder, network, rememberWallet, sweepPublic } from './funding.ts';

const RELAYER = network.relayers[0] as string;
const RELAY = network.libp2pRelays[0] as string;

async function newUser(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page; phrase: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  recordConsole(page, name);
  const phrase = await createWallet(page);
  rememberWallet(name, phrase);
  await expect(page.getByLabel('Network', { exact: true })).toHaveValue(network.id);
  return { context, page, phrase };
}

test('the website, its proving files and the relayer answer', async ({ request }) => {
  const home = await request.get('/');
  expect(home.ok()).toBe(true);
  expect(await home.text()).toContain('<div id="root">');
  expect(await home.text()).toContain('<title>Occulta State Channel</title>');
  const icon = await request.get('/favicon.svg');
  expect(icon.ok()).toBe(true);
  expect(await icon.text()).toContain('<svg');
  // The same proving file the build was made with (Cloudflare does not give its length for a HEAD).
  const zkey = await request.get('/artifacts/transfer.zkey');
  expect(zkey.ok()).toBe(true);
  expect((await zkey.body()).length).toBe(statSync(join(REPO, 'packages/framework/artifacts/transfer.zkey')).size);
  const info = await request.get(`${RELAYER}/relayer/info`);
  expect(info.ok()).toBe(true);
  expect(await info.json()).toMatchObject({ chainId: network.chainId, shieldedAddress: expect.stringMatching(/^occ/) });
  expect(RELAY).toMatch(/^\/dns4\/relay\.occulta\.space\/tcp\/443\/wss\/p2p\/12D3/);
});

test('wallet basics: a new wallet opens on Channels with the live relays, locks, unlocks and imports on another browser', async ({ browser }) => {
  const { page, phrase } = await newUser(browser, 'basics');
  await expect(page.getByRole('heading', { name: 'Channels', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invite', exact: true })).toBeVisible(); // a relay is known on Arbitrum Sepolia
  await openSettings(page, 'Network');
  await expect(card(page, 'Transaction relayers on Arbitrum Sepolia').getByRole('listitem').filter({ hasText: RELAYER })).toContainText('Network default');
  await expect(card(page, 'libp2p relays on Arbitrum Sepolia').getByRole('listitem').filter({ hasText: RELAY })).toContainText('Network default');
  await page.getByRole('button', { name: 'Lock' }).click();
  await unlock(page);

  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await other.getByLabel('Recovery phrase or private key', { exact: true }).fill(phrase);
  await setPassword(other, 'Import wallet');
  await openWallet(other);
  await expect(other.getByTestId('public-address')).toHaveText(mnemonicToAccount(phrase).address);
});

test('on a phone: the welcome screen, a new wallet and the bottom tabs', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  expect(await phraseWords(page)).toHaveLength(12);
  await page.getByRole('button', { name: '← Back' }).click();
  await createWallet(page);
  const tabs = page.getByRole('navigation', { name: 'Main' }).getByRole('link');
  await expect(tabs).toHaveText(['Channels', 'My wallet', 'Settings']);
  await openWallet(page);
  await expect(page.getByTestId('shielded-eth')).toHaveText('0 ETH');
});

test.describe('money and channels on Arbitrum Sepolia', () => {
  test.describe.configure({ mode: 'serial' });
  let alice: { context: BrowserContext; page: Page; phrase: string };
  let bob: { context: BrowserContext; page: Page; phrase: string };
  let bobPage: Page; // Bob's browser; replaced by a restored one in the channel test

  test.beforeAll(async ({ browser }) => {
    [alice, bob] = await Promise.all([newUser(browser, 'alice'), newUser(browser, 'bob')]);
    bobPage = bob.page;
    await openWallet(alice.page);
    await fund((await alice.page.getByTestId('public-address').textContent()) as `0x${string}`, '0.016', '2');
  });

  test.afterAll(async () => {
    // Give the test money back: shielded funds by withdrawal, then public funds by plain transfers.
    for (const page of [alice?.page, bobPage]) {
      if (!page || page.isClosed()) continue;
      // A channel request left open would cover the page; dialogs with their own address close on navigation.
      await page
        .getByRole('dialog', { name: 'Channel request' })
        .getByRole('button', { name: 'Decline' })
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      for (const [token, symbol, fee] of [
        ['eth', 'ETH', 0.0003],
        ['usdg', 'USDG', 0.03],
      ] as const) {
        try {
          await page.goto('/#/wallet');
          const shown = Number(((await page.getByTestId(`shielded-${token}`).textContent()) as string).split(' ')[0]);
          if (shown <= fee) continue;
          await page.goto('/#/withdraw');
          const withdraw = popup(page, 'Withdraw');
          await withdraw.getByLabel('Token', { exact: true }).selectOption(token);
          await withdraw.getByLabel(`Amount (${symbol})`, { exact: true }).fill(String(Number((shown - fee).toFixed(token === 'eth' ? 6 : 2))));
          await withdraw.getByLabel('Recipient address', { exact: true }).fill(funder.address);
          await withdraw.getByRole('button', { name: 'Withdraw' }).click();
          await confirmRelayed(page, 'Withdraw', token === 'eth' ? '0.0001 ETH' : '0.01 USDG');
          await withdraw.getByRole('button', { name: 'Close' }).click();
        } catch (err) {
          test.info().annotations.push({ type: 'leftover', description: `${symbol} not withdrawn: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
        }
      }
    }
    for (const phrase of [alice?.phrase, bob?.phrase]) {
      if (phrase) test.info().annotations.push({ type: 'returned', description: await sweepPublic(phrase).catch((err: unknown) => `sweep failed: ${String(err)}`) });
    }
  });

  test('deposit ETH and USDG, pay privately, withdraw to an address', async () => {
    const a = alice.page;
    await openWallet(a);
    await expect(a.getByTestId('public-eth')).toHaveText('0.016 ETH');
    await openAction(a, 'Deposit');
    await popup(a, 'Deposit').getByRole('button', { name: '0.01', exact: true }).click();
    await popup(a, 'Deposit').getByRole('button', { name: 'Deposit' }).click();
    await expect(a.getByTestId('shielded-eth')).toHaveText('0.01 ETH');
    await openAction(a, 'Deposit');
    await popup(a, 'Deposit').getByLabel('Token', { exact: true }).selectOption('usdg');
    await popup(a, 'Deposit').getByRole('button', { name: '1', exact: true }).click();
    await popup(a, 'Deposit').getByRole('button', { name: 'Deposit' }).click();
    await expect(a.getByTestId('shielded-usdg')).toHaveText('1 USDG');

    await openWallet(bobPage);
    const bobShielded = (await bobPage.getByTestId('shielded-address').textContent()) as string;
    for (const [token, amount, fee] of [
      ['eth', '0.003', '0.0001 ETH'],
      ['usdg', '0.5', '0.01 USDG'],
    ] as const) {
      await openAction(a, 'Send');
      const transfer = popup(a, 'Private transfer');
      await transfer.getByLabel('To shielded address', { exact: true }).fill(bobShielded);
      await transfer.getByLabel('Token', { exact: true }).selectOption(token);
      await transfer.getByLabel(`Amount (${token.toUpperCase()})`, { exact: true }).fill(amount);
      await transfer.getByRole('button', { name: 'Send privately' }).click();
      await confirmRelayed(a, 'Send privately', fee);
    }
    await expect(a.getByTestId('shielded-eth')).toHaveText('0.0069 ETH');
    await expect(a.getByTestId('shielded-usdg')).toHaveText('0.49 USDG');
    await expect(bobPage.getByTestId('shielded-eth')).toHaveText('0.003 ETH');
    await expect(bobPage.getByTestId('shielded-usdg')).toHaveText('0.5 USDG');

    // Bob withdraws to an address of his choice (here the funder, to return the money); the relayer pays the gas.
    const before = await client.getBalance({ address: funder.address });
    await openAction(bobPage, 'Withdraw');
    const withdraw = popup(bobPage, 'Withdraw');
    await withdraw.getByLabel('Amount (ETH)', { exact: true }).fill('0.001');
    await withdraw.getByLabel('Recipient address', { exact: true }).fill(funder.address);
    await withdraw.getByRole('button', { name: 'Withdraw' }).click();
    await confirmRelayed(bobPage, 'Withdraw');
    await expect(withdraw.getByText(`Withdrawn to ${funder.address}.`)).toBeVisible();
    expect((await client.getBalance({ address: funder.address })) - before).toBeGreaterThanOrEqual(10n ** 15n - 10n ** 13n); // 0.001 ETH, less any funder gas spent meanwhile
    await withdraw.getByRole('button', { name: 'Close' }).click();
    await expect(bobPage.getByTestId('shielded-eth')).toHaveText('0.0019 ETH');
  });

  test('a channel through the live relay: nickname, payments both ways, a locked receiver, a restored export, a cooperative close', async ({ browser }) => {
    const a = alice.page;
    const link = await invite(bobPage);
    await a.goto(link);
    const open = openDialog(a);
    await open.getByLabel('Nickname (optional)', { exact: true }).fill('Bob');
    await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.002');
    await open.getByRole('button', { name: 'Open channel' }).click();
    await confirmRelayed(a, 'Open channel');
    const aliceChannel = channelView(a);
    let bobChannel = await openChannel(bobPage);
    await expect(aliceChannel).toContainText('Live');
    await expect(bobChannel).toContainText('Live');
    await expect(aliceChannel.getByRole('heading', { level: 2 })).toHaveText('Bob');
    await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0019 ETH');

    await pay(a, aliceChannel, '0.0005', true);
    await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.0005 ETH');
    await pay(bobPage, bobChannel, '0.0002', true);
    await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0016 ETH');

    // Bob locks: Alice's payment is not signed, and goes first once he is back.
    await bobPage.getByRole('button', { name: 'Lock' }).click();
    await pay(a, aliceChannel, '0.0001', true);
    await expect(aliceChannel.getByRole('alert')).toHaveText('The other party is not reachable right now');
    await unlock(bobPage);
    await invite(bobPage); // reachable again
    bobChannel = await openChannel(bobPage);
    await pay(a, aliceChannel, '0.0001', true);
    await expect(aliceChannel.getByTestId('channel-mine')).toHaveText('0.0014 ETH');
    await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.0005 ETH');

    // Bob exports, and continues in a fresh browser.
    await openSettings(bobPage, 'Backup');
    const downloading = bobPage.waitForEvent('download');
    await card(bobPage, 'Export').getByRole('button', { name: 'Download export file' }).click();
    const file = join(tmpdir(), `occulta-live-export-${Date.now()}.json`);
    await (await downloading).saveAs(file);
    await bob.context.close();
    bobPage = await (await browser.newContext()).newPage();
    recordConsole(bobPage, 'bob-restored');
    await bobPage.goto('/');
    await bobPage.getByRole('button', { name: 'Restore from an export file' }).click();
    await bobPage.getByLabel('Export file', { exact: true }).setInputFiles(file);
    await bobPage.getByLabel('Password of the export file', { exact: true }).fill(PASSWORD);
    await bobPage.getByRole('button', { name: 'Restore' }).click();
    await expect(bobPage.getByRole('button', { name: 'Lock' })).toBeVisible();
    await invite(bobPage);
    bobChannel = await openChannel(bobPage);
    await pay(a, aliceChannel, '0.0001', true);
    await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.0006 ETH');

    await aliceChannel.getByRole('button', { name: 'Close channel' }).click();
    await confirmRelayed(a, 'Close channel');
    await expect(aliceChannel).toContainText('Closed');
    await expect(bobChannel).toContainText('Closed');
    await openWallet(bobPage);
    await expect(bobPage.getByTestId('shielded-eth')).toHaveText('0.0025 ETH');
  });

  test('a channel that asks the invitee to fund, without holding up the opener: declined, unanswered, then accepted with a nickname, and a started dispute', async () => {
    const a = alice.page;
    const link = await invite(bobPage);
    const request = bobPage.getByRole('dialog', { name: 'Channel request' });
    const waiting = a.getByTestId('pending-open');
    for (const answer of ['decline', 'ignore', 'accept'] as const) {
      await a.goto('/#/channels'); // a fresh form each time
      await a.goto(link);
      const open = openDialog(a);
      await open.getByLabel('You fund (ETH)', { exact: true }).fill('0.001');
      await open.getByLabel('Ask the other side to fund (ETH, optional)', { exact: true }).fill('0.0005');
      await open.getByRole('button', { name: 'Open channel' }).click();
      await confirmRelayed(a, 'Open channel'); // closes at once; the request waits in its own conversation
      await expect(waiting).toContainText('Waiting for');
      await expect(request).toContainText('They fund 0.001 ETH and ask you to fund 0.0005 ETH');
      if (answer === 'accept') {
        await request.getByLabel('Nickname for them (optional)', { exact: true }).fill('Alice');
        await request.getByRole('button', { name: 'Accept and fund' }).click();
        await expect(a).toHaveURL(/#\/channels\/[0-9a-f]{32}$/, { timeout: 300_000 }); // on to the channel
      } else {
        if (answer === 'decline') {
          // Meanwhile Alice uses the rest of the wallet.
          await openAction(a, 'Receive');
          await popup(a, 'Receive').getByRole('button', { name: 'Close' }).click();
          await request.getByRole('button', { name: 'Decline' }).click();
          await openChannels(a);
          await a.getByTestId('channel-item').first().click();
        }
        await expect(waiting).toContainText('declined, or did not answer in time', { timeout: 120_000 });
        await expect(request).toBeHidden();
        await waiting.getByRole('button', { name: 'Dismiss' }).click();
        await expect(waiting).toBeHidden();
      }
    }
    const aliceChannel = channelView(a);
    // Bob's list shows the new channel at its next refresh, above the one closed in the test before.
    await openChannels(bobPage);
    await expect(bobPage.getByTestId('channel-item').first()).not.toContainText('Closed');
    const bobChannel = await openChannel(bobPage);
    await expect(bobChannel).toContainText('Live', { timeout: 300_000 });
    await expect(bobChannel.getByRole('heading', { level: 2 })).toHaveText('Alice');
    await expect(bobChannel.getByTestId('channel-mine')).toHaveText('0.0005 ETH');
    await bobChannel.getByRole('button', { name: 'Close without the other side' }).click();
    await bobPage.getByRole('dialog', { name: 'Close without the other side' }).getByRole('button', { name: 'Start dispute' }).click();
    await expect(bobChannel).toContainText('In dispute');
    await expect(aliceChannel).toContainText('In dispute');
  });
});
