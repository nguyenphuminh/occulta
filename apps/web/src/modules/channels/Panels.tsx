import { useRef, useState } from 'react';
import { decodeInvite, inviteLink, shieldedAddressOf } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { parseAmount, tokenId, type TokenName } from '../../shared/amounts.ts';
import { LinkIcon } from '../../shared/icons.tsx';
import { AmountField, Button, Card, Copy, ErrorNote, Field, Notice, Page, Qr, RelayedSubmit, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

function isInvite(text: string): boolean {
  try {
    decodeInvite(text);
    return true;
  } catch {
    return false;
  }
}

/** BRD 2.2.6: an invite for one person to reach this wallet through a relay. */
export function InvitePanel() {
  const { occulta } = useApp();
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(async () => {
    const shielded = shieldedAddressOf(await occulta.keys.poolKeys());
    await occulta.p2p.waitForRelay();
    setLink(inviteLink(location.origin, occulta.p2p.invite(shielded)));
  });
  return (
    <Page title="Invite" back="#/channels">
      <Card title="Invite someone">
        <p className="muted">Share your invite privately. It lets one person reach you through a relay to open a channel, and it never contains your IP address.</p>
        <Button className="primary wide" busy={create.busy} onClick={() => void create.perform()}>
          <LinkIcon /> Create invite
        </Button>
        <ErrorNote error={create.error} />
        {link ? (
          <div className="invite">
            <Qr text={link} label="Invite QR code" />
            <p className="mono break" data-testid="invite-link">
              {link}
            </p>
            <Copy text={link} label="Copy invite link" />
          </div>
        ) : null}
      </Card>
    </Page>
  );
}

/** BRD 2.2.7: open and fund a channel with someone's invite. */
export function OpenPanel({ initialInvite }: { initialInvite: string }) {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const [invite, setInvite] = useState(initialInvite);
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  const [peerAmount, setPeerAmount] = useState('');
  const ask = peerAmount.trim() === '' ? 0n : parseAmount(token, peerAmount);
  const opened = useRef('');
  return (
    <Page title="Open a channel" back="#/channels">
      <Card title="Open a channel">
        <Field label="Invite link or code">
          <textarea rows={2} value={invite} spellCheck={false} placeholder="Paste the invite you received" onChange={(e) => setInvite(e.target.value.trim())} />
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
            const record = await occulta.channels.open(decodeInvite(invite), { token: tokenId(token, network), amount: parseAmount(token, amount) as bigint, peerAmount: ask ?? 0n, relayer });
            opened.current = record.id;
          }}
          onDone={() => {
            refresh();
            location.hash = `#/channels/${opened.current}`;
          }}
        />
      </Card>
    </Page>
  );
}
