import { appendFileSync, writeFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { parseAbi, parseEther, parseUnits, type Address } from 'viem';
import { devChain } from '../../scripts/lib/devnode.ts';
import { client, dev } from '../integration/chain.ts';

export const PASSWORD = 'correct horse battery';

/** The dev network the website was built with (set by the global setup). */
export function devNetworkInfo(): { id: string; name: string; usdg: string; relayers: string[]; libp2pRelays: string[] } {
  return JSON.parse(process.env.OCCULTA_UI_NETWORK as string) as { id: string; name: string; usdg: string; relayers: string[]; libp2pRelays: string[] };
}

export const card = (page: Page, title: string): Locator => page.getByRole('region', { name: title, exact: true });

/** Creates a wallet through the website's flow and returns its recovery phrase. */
export async function createWallet(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const words = await phraseWords(page);
  expect(words).toHaveLength(12);
  await page.getByLabel('I have written my recovery phrase down').check();
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  for (const label of await page.locator('.field > label').allTextContents()) {
    await page.getByLabel(label, { exact: true }).fill(words[Number(label.replace('Word #', '')) - 1] as string);
  }
  await page.getByRole('button', { name: 'Confirm words' }).click();
  await setPassword(page, 'Create wallet');
  return words.join(' ');
}

/** The words of the recovery phrase on screen, in order. */
export const phraseWords = (page: Page): Promise<string[]> => page.getByRole('list', { name: 'Recovery phrase' }).locator('.phrase-word').allTextContents();

export async function openWallet(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My wallet' }).click();
}

/** Opens one of the shielded balance's actions on My wallet; each is a dialog over it (Send is the private transfer). */
export async function openAction(page: Page, name: 'Deposit' | 'Withdraw' | 'Receive' | 'Send'): Promise<void> {
  await openWallet(page);
  await page.getByRole('navigation', { name: 'Shielded actions' }).getByRole('link', { name, exact: true }).click();
}

/** A dialog by its exact title (so Withdraw is not its own review, Confirm: Withdraw). */
export const popup = (page: Page, title: string): Locator => page.getByRole('dialog', { name: title, exact: true });

/** Opens Settings, and one of its categories (Accounts shows when none is chosen). */
export async function openSettings(page: Page, category?: 'Accounts' | 'Backup' | 'Network'): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  if (category) await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('link', { name: new RegExp(`^${category}`) }).click();
}

export async function openChannels(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Channels' }).click();
}

/** Opens the newest channel in the list and returns its conversation. */
export async function openChannel(page: Page): Promise<Locator> {
  await openChannels(page);
  await page.getByTestId('channel-item').first().click();
  return page.getByRole('region', { name: 'Channel', exact: true });
}

/** The conversation currently shown. */
export const channelView = (page: Page): Locator => page.getByRole('region', { name: 'Channel', exact: true });

/** The Open a channel dialog, from an invite link or from the Channels page. */
export const openDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Open a channel' });

export async function setPassword(page: Page, submit: string): Promise<void> {
  await page.getByLabel('Wallet password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: submit }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
}

export async function useDevNetwork(page: Page): Promise<void> {
  const { id } = devNetworkInfo();
  await page.getByLabel('Network', { exact: true }).selectOption(id);
  await expect(page.getByLabel('Network', { exact: true })).toHaveValue(id);
}

/** The dev account sends one transaction at a time, so concurrent funding never reuses a nonce. */
let devQueue: Promise<unknown> = Promise.resolve();

export function devSend<T>(send: () => Promise<T>): Promise<T> {
  const run = devQueue.then(send);
  devQueue = run.catch(() => undefined);
  return run;
}

/** Sends test ETH (and optionally test USDG) to the active account's public address and returns it. */
export async function fundPublicly(page: Page, eth: string, usdg?: string): Promise<Address> {
  await openWallet(page);
  const address = (await page.getByTestId('public-address').getAttribute('title')) as Address;
  await devSend(async () =>
    client.waitForTransactionReceipt({ hash: await dev.sendTransaction({ account: dev.account!, chain: devChain, to: address, value: parseEther(eth) }) }),
  );
  if (usdg) {
    const mint = parseAbi(['function mint(address to, uint256 value)']);
    const token = devNetworkInfo().usdg as Address;
    await devSend(async () =>
      client.waitForTransactionReceipt({
        hash: await dev.writeContract({ account: dev.account!, chain: devChain, address: token, abi: mint, functionName: 'mint', args: [address, parseUnits(usdg, 6)] }),
      }),
    );
  }
  return address;
}

export async function unlock(page: Page): Promise<void> {
  await page.getByLabel('Wallet password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
}

/** Confirms a relayed action's review dialog and waits for it to finish. */
export async function confirmRelayed(page: Page, label: string, fee = '0.0001 ETH'): Promise<void> {
  const dialog = page.getByRole('dialog', { name: `Confirm: ${label}` });
  await expect(dialog).toContainText(`Relayer fee: ${fee}`);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden({ timeout: 120_000 });
}

/** Debugging aid: OCCULTA_UI_CONSOLE=<file> appends every console line of a page to that file. */
export function recordConsole(page: Page, name: string): void {
  const file = process.env.OCCULTA_UI_CONSOLE;
  if (!file) return;
  if (process.env.OCCULTA_UI_DEBUG) void page.addInitScript((debug) => localStorage.setItem('debug', debug), process.env.OCCULTA_UI_DEBUG);
  page.on('console', (m) => appendFileSync(file, `${new Date().toISOString()} [${name}] ${m.type()} ${m.text()}\n`));
  page.on('pageerror', (e) => appendFileSync(file, `${new Date().toISOString()} [${name}] pageerror ${e.message}\n`));
}

/** Debugging aid: OCCULTA_UI_PROFILE=<file> records a CPU profile of `page` while `run` runs. */
export async function profiled<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const file = process.env.OCCULTA_UI_PROFILE;
  if (!file) return run();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  try {
    return await run();
  } finally {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(file, JSON.stringify(profile));
  }
}

/**
 * Opens the invite dialog on the Channels page, which makes the invite at once, and returns its link
 * (it also waits until the wallet is reachable). The dialog is closed again.
 */
export async function createInvite(page: Page): Promise<string> {
  await openChannels(page);
  await page.getByRole('link', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite someone' });
  await expect(dialog.getByRole('img', { name: 'Invite QR code' })).toBeVisible();
  const link = (await dialog.getByTestId('invite-link').textContent()) as string;
  expect(link).toMatch(/\/#\/invite\/[A-Za-z0-9_-]+$/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  return link;
}

/** Pays in a channel and answers the wallet's confirmation dialog. */
export async function payInChannel(page: Page, channel: Locator, amount: string, confirm: boolean, symbol = 'ETH'): Promise<void> {
  await channel.getByLabel(`Pay (${symbol})`, { exact: true }).fill(amount);
  await channel.getByRole('button', { name: 'Pay', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm payment' });
  await expect(dialog).toContainText(`Pay ${amount} ${symbol}`);
  await dialog.getByRole('button', { name: confirm ? 'Confirm payment' : 'Cancel' }).click();
}
