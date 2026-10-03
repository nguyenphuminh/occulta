import { z } from 'zod';
import type { Occulta } from '@occulta/framework';

/**
 * Names the user gives channel peers, by peer id. They are kept in the encrypted wallet for the
 * active account and network, so the export file carries them, and they are never sent to the peer.
 */
const NicknamesSchema = z.record(z.string(), z.string());
const SECTION = 'web-nicknames';
export const MAX_NICKNAME = 40;

export function nicknames(occulta: Occulta): Record<string, string> {
  return occulta.wallet.readSection(SECTION, NicknamesSchema) ?? {};
}

/** An empty name removes the nickname. */
export async function setNickname(occulta: Occulta, peerId: string, name: string): Promise<void> {
  const next = { ...nicknames(occulta) };
  const trimmed = name.trim().slice(0, MAX_NICKNAME);
  if (trimmed) next[peerId] = trimmed;
  else delete next[peerId];
  await occulta.wallet.writeSection(SECTION, next);
}
