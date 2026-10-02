import { useState } from 'react';
import { balanceOf, decodeInvite, inviteLink, isAppError, shieldedAddressOf, sideOf, type ChannelRecord, type ChannelService } from '@occulta/framework';
import { useApp } from '../../app/context.ts';
import { formatAmount, parseAmount, tokenId, tokenName, type TokenName } from '../../shared/amounts.ts';
import { AmountField, Button, Card, Copy, ErrorNote, Field, Modal, Notice, Qr, RelayedSubmit, useAction } from '../../shared/ui.tsx';
import { TokenSelect } from '../public/index.ts';

const STATUS_TEXT: Record<ChannelRecord['status'], string> = {
  opening: 'Opening',
  funding: 'Waiting for funding',
  live: 'Live',
  closing: 'Closing',
  closed: 'Closed',
  disputing: 'In dispute',
  settled: 'Settled',
};

function isInvite(text: string): boolean {
  try {
    decodeInvite(text);
    return true;
  } catch {
    return false;
  }
}

function InviteCard() {
  const { occulta } = useApp();
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(async () => {
    const shielded = shieldedAddressOf(await occulta.keys.poolKeys());
    await occulta.p2p.waitForRelay();
    setLink(inviteLink(location.origin, occulta.p2p.invite(shielded)));
  });
  return (
    <Card title="Invite someone">
      <p>Share your invite privately. It lets one person reach you through a relay to open a channel; it never contains your IP address.</p>
      <Button busy={create.busy} onClick={() => void create.perform()}>
        Create invite
      </Button>
      <ErrorNote error={create.error} />
      {link ? (
        <>
          <p className="address" data-testid="invite-link">
            {link}
          </p>
          <Copy text={link} label="Copy invite link" />
          <Qr text={link} label="Invite QR code" />
        </>
      ) : null}
    </Card>
  );
}

function OpenCard({ initialInvite }: { initialInvite: string }) {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const [invite, setInvite] = useState(initialInvite);
  const [token, setToken] = useState<TokenName>('eth');
  const [amount, setAmount] = useState('');
  const [peerAmount, setPeerAmount] = useState('');
  const ask = peerAmount.trim() === '' ? 0n : parseAmount(token, peerAmount);
  return (
    <Card title="Open a channel">
      <Field label="Invite link or code">
        <textarea rows={2} value={invite} spellCheck={false} onChange={(e) => setInvite(e.target.value.trim())} />
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
            Fund a channel with {amount} {token.toUpperCase()}
            {ask ? `, asking the other side for ${peerAmount} ${token.toUpperCase()}` : ''}.
          </p>
        }
        run={(relayer) => occulta.channels.open(decodeInvite(invite), { token: tokenId(token, network), amount: parseAmount(token, amount) as bigint, peerAmount: ask ?? 0n, relayer })}
        onDone={() => {
          setAmount('');
          setPeerAmount('');
          setInvite('');
          location.hash = '#/channels';
          refresh();
        }}
      />
    </Card>
  );
}

function ChannelRow({ record, channels }: { record: ChannelRecord; channels: ChannelService }) {
  const { occulta, refresh } = useApp();
  const network = occulta.network();
  const token = tokenName(record.token);
  const me = sideOf(record);
  const s = record.latest.state;
  const [amount, setAmount] = useState('');
  const [disputing, setDisputing] = useState(false);
  const pay = useAction(async () => {
    await channels.pay(record.id, parseAmount(token, amount) as bigint);
    setAmount('');
    refresh();
  });
  const dispute = useAction(async () => {
    await occulta.disputes.start(record.id, occulta.relayer());
    setDisputing(false);
    refresh();
  });
  const check = useAction(async () => {
    await occulta.tick();
    refresh();
  });
  return (
    <li className="channel" data-testid={`channel-${record.id}`}>
      <div className="row spread">
        <strong>{STATUS_TEXT[record.status]}</strong>
        <span className="muted">{record.role === 'A' ? 'You opened it' : 'You were invited'}</span>
      </div>
      <dl className="balances">
        <dt>Your balance</dt>
        <dd data-testid="channel-mine">{formatAmount(token, balanceOf(s, me))}</dd>
        <dt>Their balance</dt>
        <dd data-testid="channel-theirs">{formatAmount(token, balanceOf(s, me === 0 ? 1 : 0))}</dd>
        <dt>Closing fee</dt>
        <dd>{formatAmount(token, s.closingFee)}</dd>
      </dl>
      {record.status === 'live' ? (
        <div className="row">
          <AmountField label="Pay" token={token} value={amount} onChange={setAmount} />
          <Button busy={pay.busy} disabled={parseAmount(token, amount) === null} onClick={() => void pay.perform()}>
            Pay
          </Button>
        </div>
      ) : null}
      <ErrorNote error={pay.error ?? dispute.error ?? check.error} />
      <div className="row">
        {record.status === 'live' || record.status === 'closing' ? (
          <RelayedSubmit
            label="Close channel"
            token={token}
            tokenId={tokenId(token, network)}
            relayer={() => occulta.relayer()}
            details={<p>Close cooperatively with the current balances. The closing fee becomes the relayer&apos;s current fee; any difference comes from your side.</p>}
            run={(relayer) => channels.close(record.id, relayer)}
            onDone={refresh}
          />
        ) : null}
        {['funding', 'live', 'closing'].includes(record.status) ? (
          <Button className="danger" onClick={() => setDisputing(true)}>
            Close without the other side
          </Button>
        ) : null}
        {record.status === 'disputing' ? (
          <Button className="secondary" busy={check.busy} onClick={() => void check.perform()}>
            Check dispute now
          </Button>
        ) : null}
      </div>
      {record.status === 'disputing' ? (
        <Notice>While your wallet is unlocked, it answers an old state with your latest one, finalizes after the deadline and reclaims what is yours.</Notice>
      ) : null}
      {disputing ? (
        <Modal title="Close without the other side">
          <p>This starts a public dispute with your latest state. It settles after the 7-day window. Use it only if the other side stopped answering.</p>
          <ErrorNote error={dispute.error} />
          <div className="row">
            <Button className="danger" busy={dispute.busy} onClick={() => void dispute.perform()}>
              Start dispute
            </Button>
            <Button className="secondary" onClick={() => setDisputing(false)}>
              Cancel
            </Button>
          </div>
        </Modal>
      ) : null}
    </li>
  );
}

/** BRD 2.2.6–2.2.10 on the website: invites, opening, paying, closing and disputes. */
export function Channels({ invite }: { invite: string }) {
  const { occulta, version } = useApp();
  let channels: ChannelService;
  try {
    channels = occulta.channels;
  } catch (err) {
    if (isAppError(err) && err.code === 'NO_RELAY') {
      return <Notice tone="warn">Channels need a libp2p relay. Add one in Settings for this network.</Notice>;
    }
    throw err;
  }
  const list = channels.list();
  return (
    <div className="grid" data-version={version}>
      <InviteCard />
      <OpenCard key={invite} initialInvite={invite} />
      <Card title="Your channels">
        {list.length === 0 ? <p className="muted">No channels yet.</p> : null}
        <ul className="channels">
          {[...list].reverse().map((r) => (
            <ChannelRow key={r.id} record={r} channels={channels} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
