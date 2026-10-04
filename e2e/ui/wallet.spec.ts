// BRD 2.2.14.1–2.2.14.6 and 2.2.14.10 in the browser: create, import, accounts, password and lock,
// networks, the user's own RPC endpoints, reset, export and restore, the theme.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { mnemonicToAccount, privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { PASSWORD, card, createWallet, devNetworkInfo, fundPublicly, openAction, openChannels, openSettings, openWallet, phraseWords, popup, setPassword, unlock, useDevNetwork } from './helpers.ts';

/** A JSON-RPC endpoint for the browser in front of the dev node: it counts requests, can go down, or claim another chain. */
async function rpcProxy(target: string, chainId?: string) {
  const proxy = { url: '', requests: 0, down: false };
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      proxy.requests++;
      if (proxy.down) return void res.writeHead(503).end('down');
      const request = JSON.parse(body) as { id: number; method: string };
      if (chainId && request.method === 'eth_chainId') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: chainId }));
      void fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        .then((r) => r.text())
        .then((text) => res.writeHead(200, { 'content-type': 'application/json' }).end(text));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  return { proxy, close: () => server.close() };
}

/** Everything this website stored in IndexedDB, as text. */
async function storedText(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('occulta');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('kv').objectStore('kv').getAll();
          all.onsuccess = () => resolve(JSON.stringify(all.result));
        };
      }),
  );
}

test('creating a wallet: the phrase is shown once, 3 words must match, the password needs 8 characters', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Private ZK state channels on Arbitrum')).toBeVisible();
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const words = await phraseWords(page);
  expect(words).toHaveLength(12);
  await expect(page.getByRole('button', { name: 'I wrote it down' })).toBeDisabled(); // not before confirming it is saved
  await page.getByLabel('I have written my recovery phrase down').check();
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  await expect(page.getByRole('list', { name: 'Recovery phrase' })).toHaveCount(0); // shown only once

  const labels = await page.locator('.field > label').allTextContents();
  expect(labels).toHaveLength(3);
  for (const label of labels) await page.getByLabel(label, { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Confirm words' }).click();
  await expect(page.getByRole('alert')).toHaveText('Those words do not match your phrase. Try again.');
  await expect(page.getByLabel('Wallet password', { exact: true })).toHaveCount(0); // the wallet stays unusable

  for (const label of labels) await page.getByLabel(label, { exact: true }).fill(words[Number(label.replace('Word #', '')) - 1] as string);
  await page.getByRole('button', { name: 'Confirm words' }).click();
  await page.getByLabel('Wallet password', { exact: true }).fill('short');
  await expect(page.getByText('The password needs at least 8 characters.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create wallet' })).toBeDisabled();
  await setPassword(page, 'Create wallet');

  // A new wallet starts on Arbitrum Sepolia, and the browser holds only the encrypted vault.
  await expect(page.getByLabel('Network', { exact: true })).toHaveValue('arbitrum-sepolia');
  await openWallet(page);
  const address = mnemonicToAccount(words.join(' ')).address;
  await expect(page.getByTestId('public-address')).toHaveAttribute('title', address);
  const stored = await storedText(page);
  expect(stored).toContain('occulta-wallet');
  expect(stored).not.toContain(words.slice(0, 2).join(' '));
  expect(stored.toLowerCase()).not.toContain(address.slice(2).toLowerCase());

  // Closing the tab (here: reloading) locks it; a wrong password is refused.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
  await page.getByLabel('Wallet password', { exact: true }).fill('not the password');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong password');
  await page.getByLabel('Wallet password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('public-address')).toHaveAttribute('title', address);
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
});

test('importing gives the same accounts as standard wallets; accounts can be added, imported and switched', async ({ page }) => {
  const phrase = 'test test test test test test test test test test test junk';
  await page.goto('/');
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await page.getByLabel('Recovery phrase or private key', { exact: true }).fill(phrase);
  await setPassword(page, 'Import wallet');
  await openWallet(page);
  await expect(page.getByTestId('public-address')).toHaveAttribute('title', mnemonicToAccount(phrase).address);

  await openSettings(page);
  await page.getByRole('button', { name: 'Add account' }).click();
  const second = mnemonicToAccount(phrase, { addressIndex: 1 }).address;
  await expect(page.getByLabel('Account', { exact: true })).toContainText(`Account 2 · ${second.slice(0, 6)}`);
  const key = generatePrivateKey();
  await page.getByRole('button', { name: 'Import key' }).click();
  await page.getByRole('dialog').getByLabel('Private key', { exact: true }).fill(key);
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByLabel('Account', { exact: true }).selectOption(privateKeyToAccount(key).address);
  await openWallet(page);
  await expect(page.getByTestId('public-address')).toHaveAttribute('title', privateKeyToAccount(key).address);
});

test('a wallet imported from a private key has that address and cannot derive accounts', async ({ page }) => {
  const key = generatePrivateKey();
  await page.goto('/');
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await page.getByLabel('Recovery phrase or private key', { exact: true }).fill(key);
  await setPassword(page, 'Import wallet');
  await openWallet(page);
  await expect(page.getByTestId('public-address')).toHaveAttribute('title', privateKeyToAccount(key).address);
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Import key' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(0);
});

test('a forgotten password is replaced by importing the phrase, after a warning', async ({ page }) => {
  const phrase = await createWallet(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Import key' }).click();
  await page.getByRole('dialog').getByLabel('Private key', { exact: true }).fill(generatePrivateKey());
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(2);
  await page.getByRole('button', { name: 'Lock' }).click();

  await page.getByRole('button', { name: 'Forgot the password?' }).click();
  await expect(page.getByText('Imported private keys and all channel data are lost')).toBeVisible();
  await expect(page.getByLabel('Recovery phrase', { exact: true })).toHaveCount(0); // nothing until the warning is confirmed
  await page.getByLabel('I understand that imported keys and channel data will be lost', { exact: true }).check();
  await page.getByLabel('Recovery phrase', { exact: true }).fill(phrase);
  await page.getByLabel('New wallet password', { exact: true }).fill('another password');
  await page.getByRole('button', { name: 'Reset wallet' }).click();
  await openWallet(page);
  await expect(page.getByTestId('public-address')).toHaveAttribute('title', mnemonicToAccount(phrase).address);
  await expect(page.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(1); // the imported key is gone
});

test('the export file restores the wallet in a fresh browser and records when it was made', async ({ page, browser }) => {
  const phrase = await createWallet(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Add account' }).click();
  await openSettings(page, 'Backup');
  await expect(page.getByTestId('last-export')).toHaveText('Last export: never');
  const downloading = page.waitForEvent('download');
  await card(page, 'Export').getByRole('button', { name: 'Download export file' }).click();
  const file = await (await downloading).path();
  await expect(page.getByTestId('last-export')).not.toHaveText('Last export: never');
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ format: 'occulta-wallet' });

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Restore from an export file' }).click();
  await other.getByLabel('Export file', { exact: true }).setInputFiles(file);
  await other.getByLabel('Password of the export file', { exact: true }).fill('wrong password');
  await other.getByRole('button', { name: 'Restore' }).click();
  await expect(other.getByRole('alert')).toHaveText('Wrong password');
  await other.getByLabel('Password of the export file', { exact: true }).fill(PASSWORD);
  await other.getByRole('button', { name: 'Restore' }).click();
  await openWallet(other);
  await expect(other.getByTestId('public-address')).toHaveAttribute('title', mnemonicToAccount(phrase).address);
  await expect(other.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(2);
  await fresh.close();
});

test('each account and each network keeps its own notes and channels; Settings keeps added relays and relayers', async ({ page }) => {
  await createWallet(page);
  await expect(page.getByTestId('network-logo')).toBeVisible(); // a new wallet starts on Arbitrum Sepolia
  await useDevNetwork(page);
  await expect(page.getByTestId('network-logo')).toHaveCount(0); // the dev chain shows no Arbitrum logo
  await fundPublicly(page, '1');
  await openAction(page, 'Deposit');
  await popup(page, 'Deposit').getByRole('button', { name: '0.1', exact: true }).click();
  await popup(page, 'Deposit').getByRole('button', { name: 'Deposit' }).click();
  await expect(page.getByTestId('shielded-eth')).toHaveText('0.1 ETH');
  await expect(page.getByText('1 unspent note', { exact: true })).toBeVisible();

  // A second account of the same wallet sees none of the first account's notes.
  await openSettings(page);
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(2);
  await openWallet(page);
  await page.getByLabel('Account', { exact: true }).selectOption({ index: 1 });
  await expect(page.getByTestId('shielded-eth')).toHaveText('0 ETH');
  await page.getByLabel('Account', { exact: true }).selectOption({ index: 0 });
  await expect(page.getByTestId('shielded-eth')).toHaveText('0.1 ETH');

  // Another network neither, and Occulta tells where it is not deployed.
  await page.getByLabel('Network', { exact: true }).selectOption('dev-undeployed');
  await expect(page.getByText('Occulta is not deployed on Second dev chain yet.')).toBeVisible();
  await expect(page.getByTestId('shielded-eth')).toHaveText('0 ETH');
  await openChannels(page);
  await expect(page.getByText('Channels need a libp2p relay. Add one in Settings for this network.')).toBeVisible();

  // Relayers and relays added in Settings stay, also after locking, and can be removed.
  const relay = devNetworkInfo().libp2pRelays[0] as string;
  await openSettings(page, 'Network');
  const relayers = card(page, 'Transaction relayers on Second dev chain');
  const relays = card(page, 'libp2p relays on Second dev chain');
  await relayers.getByLabel('Add', { exact: true }).fill('https://relayer.example.com');
  await relayers.getByRole('button', { name: 'Add' }).click();
  await relays.getByLabel('Add', { exact: true }).fill(relay);
  await relays.getByRole('button', { name: 'Add' }).click();
  await expect(relays.getByText(relay)).toBeVisible();
  await page.getByRole('button', { name: 'Lock' }).click();
  await unlock(page);
  await expect(relayers.getByText('https://relayer.example.com')).toBeVisible();
  await expect(relays.getByText(relay)).toBeVisible();
  await openChannels(page);
  await expect(page.getByRole('link', { name: 'Invite', exact: true })).toBeVisible(); // a relay is now known on this network
  await openSettings(page, 'Network');
  await relayers.getByRole('listitem').filter({ hasText: 'https://relayer.example.com' }).getByRole('button', { name: 'Remove' }).click();
  await expect(relayers.getByText('https://relayer.example.com')).toHaveCount(0);

  await useDevNetwork(page);
  await openWallet(page);
  await expect(page.getByTestId('shielded-eth')).toHaveText('0.1 ETH');
});

test('the app opens on Channels; the phrase warning is one banner that stays closed once closed, and stays on forms that take a phrase', async ({ page }) => {
  const notice = 'Occulta only ever asks for your recovery phrase when you import a wallet. Never type it anywhere else.';
  await page.goto('/');
  await expect(page.getByText(notice)).toHaveCount(0); // not on the welcome screen
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await expect(page.getByText(notice)).toBeVisible(); // the form that takes a phrase states it
  await page.getByLabel('Recovery phrase or private key', { exact: true }).fill(generatePrivateKey());
  await setPassword(page, 'Import wallet');

  // Channels first, with the product's line under the logo and what to do before opening one.
  await expect(page.getByRole('heading', { name: 'Channels', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Channels' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Channels', 'My wallet', 'Settings']); // private transfers are a wallet dialog
  await expect(page.getByRole('link', { name: /Occulta Private ZK state channels on Arbitrum/ })).toBeVisible();
  await useDevNetwork(page); // a network with a libp2p relay, so the channel list shows
  await expect(page.getByRole('link', { name: 'deposit into your shielded balance' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your channels' })).toBeVisible(); // the pane beside the list, before a channel is chosen

  // The banner sits at the top of every page until it is closed, and then stays closed in this browser.
  const banner = page.getByRole('note');
  await expect(banner).toHaveText(notice);
  await openWallet(page);
  await expect(banner).toHaveText(notice);
  await expect(page.getByText('Your private address inside the pool.')).toBeVisible(); // both addresses explained
  await expect(page.getByText('Your public Arbitrum address.')).toBeVisible();
  await banner.getByRole('button', { name: 'Close this notice' }).click();
  await expect(page.getByRole('note')).toHaveCount(0);
  await page.reload();
  await unlock(page);
  await expect(page.getByTestId('shielded-eth')).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);

  // A form that takes a phrase keeps the statement, whatever the banner did.
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('button', { name: 'Forgot the password?' }).click();
  await page.getByLabel('I understand that imported keys and channel data will be lost', { exact: true }).check();
  await expect(page.getByText(notice)).toBeVisible();
});

test('own RPC endpoints are checked before they are kept, tried first, and with the fallback off nothing else is asked', async ({ page }) => {
  const network = JSON.parse(process.env.OCCULTA_UI_NETWORK as string) as { name: string; rpcUrl: string; chainId: number };
  const own = await rpcProxy(network.rpcUrl);
  const otherChain = await rpcProxy(network.rpcUrl, '0x1');
  await createWallet(page);
  await useDevNetwork(page);
  await fundPublicly(page, '1');
  await openAction(page, 'Deposit');
  await popup(page, 'Deposit').getByRole('button', { name: '0.1', exact: true }).click();
  await popup(page, 'Deposit').getByRole('button', { name: 'Deposit' }).click();
  await expect(page.getByTestId('shielded-eth')).toHaveText('0.1 ETH');

  await openSettings(page, 'Network');
  const rpc = card(page, `RPC endpoints on ${network.name}`);
  const add = async (url: string) => {
    await rpc.getByLabel('Add your own', { exact: true }).fill(url);
    await rpc.getByRole('button', { name: 'Add' }).click();
  };
  await add('http://127.0.0.1:9/rpc');
  await expect(rpc.getByRole('alert')).toHaveText('This RPC endpoint does not answer');
  await add(otherChain.proxy.url);
  await expect(rpc.getByRole('alert')).toHaveText(`This endpoint serves chain 1, not ${network.name} (${network.chainId})`);
  await add(own.proxy.url);
  await expect(rpc.getByRole('listitem').filter({ hasText: own.proxy.url }).getByRole('button', { name: 'Remove' })).toBeVisible();
  const fallback = rpc.getByLabel('Use the network’s endpoints when mine do not answer');
  await expect(fallback).toBeChecked();
  await fallback.uncheck();
  await expect(rpc.getByRole('listitem').filter({ hasText: network.rpcUrl })).toContainText('Not used');

  // From now on only the user's endpoint is asked, also when it stops answering.
  await expect.poll(() => own.proxy.requests).toBeGreaterThan(0);
  await page.waitForTimeout(2_000); // what the previous node had under way is done
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));
  await openWallet(page);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('shielded-eth')).toHaveText('0.1 ETH');
  own.proxy.down = true;
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('alert').filter({ hasText: `No RPC endpoint of ${network.name} is answering` }).first()).toBeVisible(); // also for the public balance
  expect(asked.filter((url) => url.startsWith(network.rpcUrl))).toEqual([]);

  // With the fallback back on, the network's endpoint takes over.
  await openSettings(page, 'Network');
  await fallback.check();
  await openWallet(page);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No RPC endpoint' })).toHaveCount(0);
  await expect.poll(() => asked.some((url) => url.startsWith(network.rpcUrl))).toBe(true);

  // Kept in the wallet, across a lock; and removable.
  await page.getByRole('button', { name: 'Lock' }).click();
  await unlock(page);
  await openSettings(page, 'Network');
  await rpc.getByRole('listitem').filter({ hasText: own.proxy.url }).getByRole('button', { name: 'Remove' }).click();
  await expect(rpc.getByText(own.proxy.url)).toHaveCount(0);
  await expect(fallback).toHaveCount(0); // only shown while the user has endpoints of their own
  own.close();
  otherChain.close();
});

test('the theme follows the device until one is chosen in Settings, and the choice holds from the lock screen on', async ({ page }) => {
  const background = (rgb: string) => expect(page.locator('body')).toHaveCSS('background-color', rgb);
  const dark = 'rgb(0, 0, 0)';
  const light = 'rgb(255, 255, 255)';
  await page.emulateMedia({ colorScheme: 'dark' });
  await createWallet(page);
  await background(dark);

  await openSettings(page, 'Appearance');
  await expect(page.getByLabel('Same as this device', { exact: true })).toBeChecked();
  await page.getByLabel('Light', { exact: true }).check();
  await background(light);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await background(light); // the lock screen already has it, on a dark device

  await unlock(page);
  await openSettings(page, 'Appearance');
  await expect(page.getByLabel('Light', { exact: true })).toBeChecked();
  await page.getByLabel('Same as this device', { exact: true }).check();
  await background(dark);
  await page.emulateMedia({ colorScheme: 'light' });
  await background(light); // and follows the device at once
});
