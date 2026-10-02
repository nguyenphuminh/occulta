// BRD 2.2.2–2.2.5 and 2.2.14.4 in the browser: public funds, deposit with presets, private transfer
// with the relayer fee shown first, and withdrawal to a never-used account of the wallet.
import { expect, test } from '@playwright/test';
import { parseAbi, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { client } from '../integration/chain.ts';
import { card, confirmRelayed, createWallet, devNetworkInfo, fundPublicly, goHome, openAction, useDevNetwork } from './helpers.ts';

test('public funds, deposit, private transfer and withdrawal to a new account', async ({ browser }) => {
  const [alice, bob] = await Promise.all([browser.newContext().then((c) => c.newPage()), browser.newContext().then((c) => c.newPage())]);
  for (const page of [alice, bob]) {
    await createWallet(page);
    await useDevNetwork(page);
  }

  // Public balance and receive screen.
  const aliceAddress = await fundPublicly(alice, '1');
  await expect(alice.getByTestId('public-eth')).toHaveText('1 ETH');
  await openAction(alice, 'Receive');
  await expect(card(alice, 'Public address').getByRole('img', { name: 'Address QR code' })).toBeVisible();
  await expect(card(alice, 'Private payments').getByRole('img', { name: 'Shielded address QR code' })).toBeVisible();

  // Deposit: presets in powers of ten, a hint (never a block) for other amounts.
  await openAction(alice, 'Deposit');
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
  await goHome(bob);
  await expect(bob.getByTestId('shielded-address')).toHaveText(/^occ[0-9a-f]{136}$/);
  const bobShielded = (await bob.getByTestId('shielded-address').textContent()) as string;
  await openAction(alice, 'Send');
  const transfer = card(alice, 'Private transfer');
  await transfer.getByLabel('To shielded address', { exact: true }).fill(bobShielded);
  await transfer.getByLabel('Amount (ETH)', { exact: true }).fill('0.03');
  await transfer.getByRole('button', { name: 'Send privately' }).click();
  await confirmRelayed(alice, 'Send privately');
  await expect(alice.getByTestId('shielded-eth')).toHaveText('0.0699 ETH');
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.03 ETH');

  // Withdrawal to a never-used account of Bob's wallet, with the waiting tip; no ETH needed there.
  await openAction(bob, 'Withdraw');
  const withdraw = card(bob, 'Withdraw');
  await expect(withdraw.getByText('Tip: waiting longer between depositing and withdrawing')).toBeVisible();
  await withdraw.getByRole('button', { name: '0.01', exact: true }).click();
  await withdraw.getByRole('button', { name: 'Withdraw' }).click();
  await confirmRelayed(bob, 'Withdraw');
  const done = (await withdraw.getByText(/^Withdrawn to 0x/).textContent()) as string;
  const exit = done.match(/0x[0-9a-fA-F]{40}/)?.[0] as `0x${string}`;
  expect(await client.getBalance({ address: exit })).toBe(parseEther('0.01'));
  await goHome(bob);
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.0199 ETH');
  await expect(bob.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(2);

  // A public send from Alice's account.
  await openAction(alice, 'Send publicly');
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const send = card(alice, 'Send publicly');
  await send.getByLabel('To address', { exact: true }).fill(to);
  await send.getByLabel('Amount (ETH)', { exact: true }).fill('0.05');
  await send.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => client.getBalance({ address: to })).toBe(parseEther('0.05'));
});

test('USDG: public balance, deposit with approval, private transfer, withdrawal to another address, clear errors', async ({ browser }) => {
  const [alice, bob] = await Promise.all([browser.newContext().then((c) => c.newPage()), browser.newContext().then((c) => c.newPage())]);
  for (const page of [alice, bob]) {
    await createWallet(page);
    await useDevNetwork(page);
  }
  await fundPublicly(alice, '1', '100');
  await expect(alice.getByTestId('public-usdg')).toHaveText('100 USDG');

  // Deposit: the wallet approves the pool to take the USDG, then deposits.
  await openAction(alice, 'Deposit');
  const deposit = card(alice, 'Deposit');
  await deposit.getByLabel('Token', { exact: true }).selectOption('usdg');
  await expect(deposit.getByRole('button', { name: '1000', exact: true })).toBeVisible(); // USDG presets
  await deposit.getByRole('button', { name: '10', exact: true }).click();
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('10 USDG');
  await expect(card(alice, 'Notes').getByText('1 unspent note')).toBeVisible();

  await goHome(bob);
  await expect(bob.getByTestId('shielded-address')).toHaveText(/^occ/);
  const bobShielded = (await bob.getByTestId('shielded-address').textContent()) as string;
  await openAction(alice, 'Send');
  const transfer = card(alice, 'Private transfer');
  await transfer.getByLabel('To shielded address', { exact: true }).fill(bobShielded);
  await transfer.getByLabel('Token', { exact: true }).selectOption('usdg');
  await transfer.getByLabel('Amount (USDG)', { exact: true }).fill('2.5');
  await transfer.getByRole('button', { name: 'Send privately' }).click();
  await confirmRelayed(alice, 'Send privately', '0.01 USDG');
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('7.49 USDG');
  await expect(bob.getByTestId('shielded-usdg')).toHaveText('2.5 USDG');

  // More than she holds: refused with an explanation, nothing sent.
  await openAction(alice, 'Send');
  await transfer.getByLabel('To shielded address', { exact: true }).fill(bobShielded);
  await transfer.getByLabel('Token', { exact: true }).selectOption('usdg');
  await transfer.getByLabel('Amount (USDG)', { exact: true }).fill('50');
  await transfer.getByRole('button', { name: 'Send privately' }).click();
  const dialog = alice.getByRole('dialog', { name: 'Confirm: Send privately' });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Not enough shielded funds in this token (including the relayer fee)');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await goHome(alice);
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('7.49 USDG');

  // Withdrawal to an address of Bob's choice.
  const to = privateKeyToAccount(generatePrivateKey()).address;
  await openAction(bob, 'Withdraw');
  const withdraw = card(bob, 'Withdraw');
  await withdraw.getByLabel('Token', { exact: true }).selectOption('usdg');
  await withdraw.getByRole('button', { name: '1', exact: true }).click();
  await withdraw.getByLabel('Another address').check();
  await withdraw.getByLabel('Recipient address', { exact: true }).fill(to);
  await withdraw.getByRole('button', { name: 'Withdraw' }).click();
  await confirmRelayed(bob, 'Withdraw', '0.01 USDG');
  await expect(withdraw.getByText(`Withdrawn to ${to}.`)).toBeVisible();
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
  expect(await client.readContract({ address: devNetworkInfo().usdg as `0x${string}`, abi: erc20, functionName: 'balanceOf', args: [to] })).toBe(1_000_000n);
  await goHome(bob);
  await expect(bob.getByTestId('shielded-usdg')).toHaveText('1.49 USDG');
});
