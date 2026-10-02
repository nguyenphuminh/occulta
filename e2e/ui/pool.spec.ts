// BRD 2.2.2–2.2.5 and 2.2.14.4 in the browser: public funds, deposit with presets, private transfer
// with the relayer fee shown first, and withdrawal to a never-used account of the wallet.
import { expect, test } from '@playwright/test';
import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { client } from '../integration/chain.ts';
import { card, confirmRelayed, createWallet, fundPublicly, useDevNetwork } from './helpers.ts';

test('public funds, deposit, private transfer and withdrawal to a new account', async ({ browser }) => {
  const [alice, bob] = await Promise.all([browser.newContext().then((c) => c.newPage()), browser.newContext().then((c) => c.newPage())]);
  for (const page of [alice, bob]) {
    await createWallet(page);
    await useDevNetwork(page);
  }

  // Public balance and receive screen.
  const aliceAddress = await fundPublicly(alice, '1');
  await expect(alice.getByTestId('public-eth')).toHaveText('1 ETH');
  await expect(card(alice, 'Receive').getByRole('img', { name: 'Address QR code' })).toBeVisible();

  // Deposit: presets in powers of ten, a hint (never a block) for other amounts.
  await alice.getByRole('link', { name: 'Shielded' }).click();
  const deposit = card(alice, 'Deposit');
  await deposit.getByLabel('Amount (ETH)', { exact: true }).fill('0.15');
  await expect(deposit.getByText('Round amounts (1, 10, 100…) are harder to trace')).toBeVisible();
  await expect(deposit.getByRole('button', { name: 'Deposit' })).toBeEnabled();
  await deposit.getByRole('button', { name: '0.1', exact: true }).click();
  await expect(deposit.getByText('Round amounts (1, 10, 100…) are harder to trace')).toHaveCount(0);
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(alice.getByTestId('shielded-eth')).toHaveText('0.1 ETH');
  expect(await client.getBalance({ address: aliceAddress })).toBeLessThan(parseEther('0.9'));

  // Private transfer to Bob's shielded address; the relayer's fee is shown before submitting.
  await bob.getByRole('link', { name: 'Shielded' }).click();
  await expect(bob.getByTestId('shielded-address')).toHaveText(/^occ[0-9a-f]{136}$/);
  const bobShielded = (await bob.getByTestId('shielded-address').textContent()) as string;
  const transfer = card(alice, 'Private transfer');
  await transfer.getByLabel('To shielded address', { exact: true }).fill(bobShielded);
  await transfer.getByLabel('Amount (ETH)', { exact: true }).fill('0.03');
  await transfer.getByRole('button', { name: 'Send privately' }).click();
  await confirmRelayed(alice, 'Send privately');
  await expect(alice.getByTestId('shielded-eth')).toHaveText('0.0699 ETH');
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.03 ETH');

  // Withdrawal to a never-used account of Bob's wallet, with the waiting tip; no ETH needed there.
  const withdraw = card(bob, 'Withdraw');
  await expect(withdraw.getByText('Tip: waiting longer between depositing and withdrawing')).toBeVisible();
  await withdraw.getByRole('button', { name: '0.01', exact: true }).click();
  await withdraw.getByRole('button', { name: 'Withdraw' }).click();
  await confirmRelayed(bob, 'Withdraw');
  const done = (await withdraw.getByText(/^Withdrawn to 0x/).textContent()) as string;
  const exit = done.match(/0x[0-9a-fA-F]{40}/)?.[0] as `0x${string}`;
  expect(await client.getBalance({ address: exit })).toBe(parseEther('0.01'));
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.0199 ETH');
  await expect(bob.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(2);

  // A public send from Alice's account.
  await alice.getByRole('link', { name: 'Public' }).click();
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const send = card(alice, 'Send publicly');
  await send.getByLabel('To address', { exact: true }).fill(to);
  await send.getByLabel('Amount (ETH)', { exact: true }).fill('0.05');
  await send.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => client.getBalance({ address: to })).toBe(parseEther('0.05'));
});
