// BRD 2.2.2–2.2.5 and 2.2.14.4 in the browser: public funds, deposit with presets, private transfer
// with the relayer fee shown first, and withdrawal to an address of the user's choice.
import { expect, test } from '@playwright/test';
import { parseAbi, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { client } from '../integration/chain.ts';
import { card, confirmRelayed, createWallet, devNetworkInfo, fundPublicly, openAction, openWallet, popup, useDevNetwork } from './helpers.ts';

test('public funds, and deposit, private transfer, receive and withdrawal as dialogs over My wallet', async ({ browser }) => {
  const [alice, bob] = await Promise.all([browser.newContext().then((c) => c.newPage()), browser.newContext().then((c) => c.newPage())]);
  for (const page of [alice, bob]) {
    await createWallet(page);
    await useDevNetwork(page);
  }

  // Public balance and receive screen.
  const aliceAddress = await fundPublicly(alice, '1');
  await expect(alice.getByTestId('public-eth')).toHaveText('1 ETH');
  await expect(card(alice, 'Public balance').getByText('Everyone can see this address and its balance.')).toBeVisible();
  await expect(alice.getByText('Send publicly')).toHaveCount(0); // public sends belong to other wallets
  await openAction(alice, 'Receive');
  await expect(card(alice, 'Public address').getByRole('img', { name: 'Address QR code' })).toBeVisible();
  await expect(card(alice, 'Private payments').getByRole('img', { name: 'Shielded address QR code' })).toBeVisible();
  await expect(card(alice, 'Private payments').getByText('payments to it cannot be seen on-chain')).toBeVisible();
  await popup(alice, 'Receive').getByRole('button', { name: 'Close' }).click();
  await expect(popup(alice, 'Receive')).toBeHidden();

  // Deposit: presets in powers of ten, a hint (never a block) for other amounts.
  await openAction(alice, 'Deposit');
  const deposit = popup(alice, 'Deposit');
  await deposit.getByLabel('Amount (ETH)', { exact: true }).fill('0.15');
  await expect(deposit.getByText('Round amounts (1, 10, 100…) are harder to trace')).toBeVisible();
  await expect(deposit.getByRole('button', { name: 'Deposit' })).toBeEnabled();
  await deposit.getByRole('button', { name: '0.1', exact: true }).click();
  await expect(deposit.getByText('Round amounts (1, 10, 100…) are harder to trace')).toHaveCount(0);
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(deposit).toBeHidden(); // done: back to My wallet
  await expect(alice.getByTestId('shielded-eth')).toHaveText('0.1 ETH');
  expect(await client.getBalance({ address: aliceAddress })).toBeLessThan(parseEther('0.9'));

  // Private transfer to Bob's shielded address; the relayer's fee is shown before submitting.
  await openWallet(bob);
  // Shown short, as wallets show addresses; the whole of it is copied.
  await expect(bob.getByTestId('shielded-address')).toHaveText(/^occ[0-9a-f]{8}…[0-9a-f]{8}$/);
  await expect(bob.getByTestId('shielded-address')).toHaveAttribute('title', /^occ[0-9a-f]{136}$/);
  const bobShielded = (await bob.getByTestId('shielded-address').getAttribute('title')) as string;
  await openAction(alice, 'Send');
  const transfer = popup(alice, 'Private transfer');
  await transfer.getByLabel('To shielded address', { exact: true }).fill(bobShielded);
  await transfer.getByLabel('Amount (ETH)', { exact: true }).fill('0.03');
  await transfer.getByRole('button', { name: 'Send privately' }).click();
  await confirmRelayed(alice, 'Send privately');
  await expect(alice.getByTestId('shielded-eth')).toHaveText('0.0699 ETH');
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.03 ETH');

  // Withdrawal to an address with no history, with the waiting tip; it needs no ETH of its own.
  const exit = privateKeyToAccount(generatePrivateKey()).address;
  await openAction(bob, 'Withdraw');
  const withdraw = popup(bob, 'Withdraw');
  await expect(withdraw.getByText('Tip: waiting longer between depositing and withdrawing')).toBeVisible();
  await withdraw.getByRole('button', { name: '0.01', exact: true }).click();
  await expect(withdraw.getByRole('button', { name: 'Withdraw' })).toBeDisabled(); // no recipient yet
  await expect(withdraw.getByText('for example a new account in MetaMask')).toBeVisible();
  await withdraw.getByLabel('Recipient address', { exact: true }).fill(exit);
  await withdraw.getByRole('button', { name: 'Withdraw' }).click();
  await confirmRelayed(bob, 'Withdraw');
  await expect(withdraw.getByText(`Withdrawn to ${exit}.`)).toBeVisible();
  expect(await client.getBalance({ address: exit })).toBe(parseEther('0.01'));
  await withdraw.getByRole('button', { name: 'Close' }).click();
  await openWallet(bob);
  await expect(bob.getByTestId('shielded-eth')).toHaveText('0.0199 ETH');
  await expect(bob.getByLabel('Account', { exact: true }).locator('option')).toHaveCount(1); // no account was added for it
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
  const deposit = popup(alice, 'Deposit');
  await deposit.getByLabel('Token', { exact: true }).selectOption('usdg');
  await expect(deposit.getByRole('button', { name: '1000', exact: true })).toBeVisible(); // USDG presets
  await deposit.getByRole('button', { name: '10', exact: true }).click();
  await deposit.getByRole('button', { name: 'Deposit' }).click();
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('10 USDG');
  await expect(alice.getByText('1 unspent note', { exact: true })).toBeVisible();

  await openWallet(bob);
  await expect(bob.getByTestId('shielded-address')).toHaveAttribute('title', /^occ/);
  const bobShielded = (await bob.getByTestId('shielded-address').getAttribute('title')) as string;
  await openAction(alice, 'Send'); // the shielded balance's Send is the private transfer
  const transfer = popup(alice, 'Private transfer');
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
  await transfer.getByRole('button', { name: 'Close' }).click();
  await openWallet(alice);
  await expect(alice.getByTestId('shielded-usdg')).toHaveText('7.49 USDG');

  // Withdrawal to an address of Bob's choice.
  const to = privateKeyToAccount(generatePrivateKey()).address;
  await openAction(bob, 'Withdraw');
  const withdraw = popup(bob, 'Withdraw');
  await withdraw.getByLabel('Token', { exact: true }).selectOption('usdg');
  await withdraw.getByRole('button', { name: '1', exact: true }).click();
  await withdraw.getByLabel('Recipient address', { exact: true }).fill(to);
  await withdraw.getByRole('button', { name: 'Withdraw' }).click();
  await confirmRelayed(bob, 'Withdraw', '0.01 USDG');
  await expect(withdraw.getByText(`Withdrawn to ${to}.`)).toBeVisible();
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
  expect(await client.readContract({ address: devNetworkInfo().usdg as `0x${string}`, abi: erc20, functionName: 'balanceOf', args: [to] })).toBe(1_000_000n);
  await withdraw.getByRole('button', { name: 'Close' }).click();
  await openWallet(bob);
  await expect(bob.getByTestId('shielded-usdg')).toHaveText('1.49 USDG');
});
