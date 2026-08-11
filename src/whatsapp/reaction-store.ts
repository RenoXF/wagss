import { sql } from '@/db/client';

export interface ReactionRow {
  chat_jid: string;
  message_id: string;
  from_jid: string;
  reaction_text: string;
  ts: number;
}

/**
 * Handle a Baileys `messages.reaction` event item.
 * reaction.text falsey = reaction removed.
 */
export async function saveReaction(evt: {
  key: { id?: string; remoteJid?: string; participant?: string };
  reaction: {
    text?: string | null;
    timestamp?: number | { toNumber?: () => number };
  };
}): Promise<void> {
  const chatJid = evt.key.remoteJid;
  const messageId = evt.key.id;
  const fromJid = evt.key.participant ?? chatJid;
  if (!chatJid || !messageId || !fromJid) return;

  const text = evt.reaction?.text ? String(evt.reaction.text) : null;
  const rawTs = evt.reaction?.timestamp as
    number | { toNumber?: () => number } | undefined;
  const ts =
    typeof rawTs === 'number'
      ? rawTs
      : ((rawTs as { toNumber?: () => number } | undefined)?.toNumber?.() ??
        Date.now());

  if (!text) {
    await sql`DELETE FROM message_reactions
      WHERE chat_jid = ${chatJid} AND message_id = ${messageId} AND from_jid = ${fromJid}`;
    return;
  }

  await sql`
    INSERT INTO message_reactions (chat_jid, message_id, from_jid, reaction_text, ts)
    VALUES (${chatJid}, ${messageId}, ${fromJid}, ${text}, ${ts})
    ON CONFLICT (chat_jid, message_id, from_jid, reaction_text)
    DO UPDATE SET ts = excluded.ts
  `;
}

export async function listReactions(
  chatJid: string,
  messageId: string,
): Promise<ReactionRow[]> {
  return sql<ReactionRow[]>`
    SELECT chat_jid, message_id, from_jid, reaction_text, ts
    FROM message_reactions
    WHERE chat_jid = ${chatJid} AND message_id = ${messageId}
  `;
}

export async function listChatReactions(
  chatJid: string,
): Promise<Record<string, ReactionRow[]>> {
  const rows = await sql<ReactionRow[]>`
    SELECT chat_jid, message_id, from_jid, reaction_text, ts
    FROM message_reactions WHERE chat_jid = ${chatJid}
  `;
  const out: Record<string, ReactionRow[]> = {};
  for (const r of rows) {
    (out[r.message_id] ??= []).push(r);
  }
  return out;
}
