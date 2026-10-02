// BRD 2.2.14.1–2.2.14.6 in the browser: create, import, accounts, password and lock, networks,
// reset, export and restore.
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { mnemonicToAccount, privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { PASSWORD, card, createWallet, setPassword } from './helpers.ts';

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
  await expect(page.getByText('Occulta only ever asks for your recovery phrase when you import a wallet')).toBeVisible();
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  const words = await page.getByRole('list', { name: 'Recovery phrase' }).locator('li').allTextContents();
  expect(words).toHaveLength(12);
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
  const address = mnemonicToAccount(words.join(' ')).address;
  await expect(page.getByTestId('public-address')).toHaveText(address);
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
  await expect(page.getByTestId('public-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Lock' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet' })).toBeVisible();
});

test('importing gives the same accounts as standard wallets; accounts can be added, imported and switched', async ({ page }) => {
  const phrase = 'test test test test test test test test test test test junk';
  await page.goto('/');
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await page.getByLabel('Recovery phrase or private key', { exact: true }).fill(phrase);
  await setPassword(page, 'Import wallet');
  await expect(page.getByTestId('public-address')).toHaveText(mnemonicToAccount(phrase).address);

  await page.getByRole('button', { name: 'Add account' }).click();
  const second = mnemonicToAccount(phrase, { addressIndex: 1 }).address;
  await expect(page.getByLabel('Account', { exact: true })).toContainText(`Account 2 · ${second.slice(0, 6)}`);
  const key = generatePrivateKey();
  await page.getByRole('button', { name: 'Import key' }).click();
  await page.getByRole('dialog').getByLabel('Private key', { exact: true }).fill(key);
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByLabel('Account', { exact: true }).selectOption(privateKeyToAccount(key).address);
  await expect(page.getByTestId('public-address')).toHaveText(privateKeyToAccount(key).address);
});

test('a wallet imported from a private key has that address and cannot derive accounts', async ({ page }) => {
  const key = generatePrivateKey();
  await page.goto('/');
  await page.getByRole('button', { name: 'Import a recovery phrase or private key' }).click();
  await page.getByLabel('Recovery phrase or private key', { exact: true }).fill(key);
  await setPassword(page, 'Import wallet');
  await expect(page.getByTestId('public-address')).toHaveText(privateKeyToAccount(key).address);
  await expect(page.getByRole('button', { name: 'Add account' })).toHaveCount(0);
});

test('a forgotten password is replaced by importing the phrase, after a warning', async ({ page }) => {
  const phrase = await createWallet(page);
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
  await expect(page.getByTestId('public-address')).toHaveText(mnemonicToAccount(phrase).address);
  await expect(page.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(1); // the imported key is gone
});

test('the export file restores the wallet in a fresh browser and records when it was made', async ({ page, browser }) => {
  const phrase = await createWallet(page);
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
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
  await expect(other.getByTestId('public-address')).toHaveText(mnemonicToAccount(phrase).address);
  await expect(other.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(2);
  await fresh.close();
});
