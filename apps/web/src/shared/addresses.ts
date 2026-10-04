// What each kind of address is for, said the same way wherever it is shown (BRD 2.2.0, 2.2.14.4).

export const SHIELDED_ADDRESS_TEXT = 'Your private address inside the pool. Share it to get paid privately: payments to it cannot be seen on-chain.';

export const PUBLIC_ADDRESS_TEXT =
  'Your public Arbitrum address. Send ETH or USDG here from another wallet, such as MetaMask, to deposit it, and keep a little ETH here for gas. Everyone can see this address and its balance.';

/** An address short enough to read at a glance: its start and end, as wallets show them. The full one is copied. */
export function shortAddress(address: string): string {
  const [head, tail] = address.startsWith('0x') ? [6, 4] : [11, 8];
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}
