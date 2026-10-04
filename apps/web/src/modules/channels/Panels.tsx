import { useEffect, useRef, useState } from 'react';
import { decodeInvite, inviteLink, quotedFee, shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, Copy, ErrorNote, Field, Modal, Notice, Qr, RelayedSubmit, closeTo, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';
import { MAX_NICKNAME, setNickname } from './nicknames.ts';

function isInvite(text: string): boolean {
  try {
    decodeInvite(text);
    return true;
  } catch {
    return false;
  }
}

const closeToList = closeTo('#/channels');

/** BRD 2.2.6: an invite for one person to reach this wallet through a relay, made as soon as it is asked for. */
export function InviteDialog() {
  const { occulta } = useApp();
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(async () => {
    const shielded = shieldedAddressOf(await occulta.keys.poolKeys());
    await occulta.p2p.waitForRelay();
    setLink(inviteLink(location.origin, occulta.p2p.invite(shielded)));
  });
  const start = useRef(create.perform);
  useEffect(() => {
    void start.current();
  }, []);
  return (
    <Modal title="Invite someone" onClose={closeToList}>
      <p className="muted">Share your invite privately. It lets one person reach you through a relay to open a channel, and it never contains your IP address.</p>
      {link ? (
        <div className="invite">
          <Qr text={link} label="Invite QR code" />
          <p className="mono break invite-link" data-testid="invite-link">
            {link}
          </p>
          <Copy text={link} label="Copy invite link" />
        </div>
      ) : create.error ? (
        <>
          <ErrorNote error={create.error} />
          <Button className="secondary wide" onClick={() => void create.perform()}>
            Try again
          </Button>
        </>
      ) : (
        <p className="waiting" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Connecting to a relay…
        </p>
      )}
    </Modal>
  );
}

/**
 * BRD 2.2.7: open and fund a channel with someone's invite, optionally naming them. Confirming hands
 * the open to the background (BRD 2.2.14.8): its conversation shows the progress while the other side
 * decides, and the rest of the wallet stays usable.
 */
export function OpenDialog({ initialInvite }: { initialInvite: string }) {
  const { occulta, pendingOpens } = useApp();
  const network = occulta.network();
  const [invite, setInvite] = useState(initialInvite);
  const [nickname, setNicknameText] = useState('');
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  const [peerAmount, setPeerAmount] = useState('');
  const ask = peerAmount.trim() === '' ? 0n : parseAmount(token, peerAmount);
  const opened = useRef('');
  return (
    <Modal title="Open a channel" onClose={closeToList}>
      <Field label="Invite link or code">
        <textarea rows={2} value={invite} spellCheck={false} placeholder="Paste the invite you received" onChange={(e) => setInvite(e.target.value.trim())} />
      </Field>
      <Field label="Nickname (optional)" hint="Only you see it. You can change it later.">
        <input value={nickname} maxLength={MAX_NICKNAME} placeholder="e.g. Alice" onChange={(e) => setNicknameText(e.target.value)} />
      </Field>
      <TokenSelect value={token} onChange={setToken} />
      <AmountField label="You fund" token={token} value={amount} onChange={setAmount} />
      <Field label={`Ask the other side to fund (${token.toUpperCase()}, optional)`}>
        <input inputMode="decimal" value={peerAmount} placeholder="0" onChange={(e) => setPeerAmount(e.target.value)} />
      </Field>
      <Notice>Dispute window: 7 days. The relayer&apos;s current fee is also set aside from your side as the closing fee.</Notice>
      <RelayedSubmit
        label="Open channel"
        token={token}
        tokenId={tokenId(token, network)}
        disabled={!isInvite(invite) || parseAmount(token, amount) === null || ask === null}
        relayer={() => occulta.relayer()}
        details={
          <p>
            Fund a channel with <strong>{amount} {token.toUpperCase()}</strong>
            {ask ? `, asking the other side for ${peerAmount} ${token.toUpperCase()}` : ''}.
          </p>
        }
        run={async (relayer) => {
          const target = decodeInvite(invite);
          const terms = { token: tokenId(token, network), amount: parseAmount(token, amount) as bigint, peerAmount: ask ?? 0n };
          // Checked here too, so a channel this wallet cannot fund is refused before the other side hears of it.
          const fee = quotedFee(await relayer.info(), terms.token);
          await occulta.pool.sync();
          const shielded = occulta.pool.balances().get(terms.token) ?? 0n;
          if (shielded < terms.amount + fee) {
            throw new Error(`Your shielded balance has ${formatAmount(token, shielded)}. Funding ${formatAmount(token, terms.amount)} also pays the relayer ${formatAmount(token, fee)}.`);
          }
          if (nickname.trim()) await setNickname(occulta, target.peerId, nickname);
          const { channels, wallet } = occulta;
          opened.current = pendingOpens.start(
            { accountId: wallet.activeAccount().id, networkId: network.id, peerId: target.peerId, ...terms },
            (onAccepted) => channels.open(target, { ...terms, relayer, onAccepted }),
            // Someone still looking at the request follows it to the channel.
            (pendingId, channelId) => {
              if (location.hash === `#/channels/${pendingId}`) location.hash = `#/channels/${channelId}`;
            },
          );
        }}
        onDone={() => {
          location.hash = `#/channels/${opened.current}`;
        }}
      />
    </Modal>
  );
}
