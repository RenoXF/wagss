import { sql } from '@/db/client';

export interface StatusRow {
  chat_jid: string;
  message_id: string;
  to_jid: string | null;
  status: string;
  ts: number;
}

/**
 * Persist a message status timeline entry.
 * Source 1: Baileys `messages.update` -> u.update.status (1 sent, 2 delivered, 3 read).
 * Source 2: Baileys `message-receipt.update` -> receipt.type (sent/delivery/read).
 */
export async function saveStatus(e: {
  key?: {
    id?: string | null;
    remoteJid?: string | null;
    participant?: string | null;
  };
  update?: { status?: number };
  receipt?: {
    type?: 'sent' | 'delivery' | 'read' | 'play' | string;
    userJid?: string | null;
    receiptTimestamp?: number;
    readTimestamp?: number;
  };
}): Promise<void> {
  const chatJid = e.key?.remoteJid;
  const messageId = e.key?.id;
  if (!chatJid || !messageId) return;

  const toJid =
    e.receipt?.userJid ??
    (e.key?.participant === chatJid ? null : (e.key?.participant ?? null));

  let status: string | null = null;
  if (e.update && typeof e.update.status === 'number') {
    // WebMessageInfo.Status: 2 SERVER_ACK(sent), 3 DELIVERY_ACK, 4 READ, 5 PLAYED
    status =
      e.update.status === 4
        ? 'read'
        : e.update.status === 3
          ? 'delivered'
          : e.update.status === 2
            ? 'sent'
            : e.update.status === 5
              ? 'played'
              : 'sent';
  } else if (e.receipt?.type) {
    status = e.receipt.type === 'delivery' ? 'delivered' : e.receipt.type;
  }
  if (!status) return;

  const rawTs =
    e.receipt?.readTimestamp ?? e.receipt?.receiptTimestamp ?? Date.now();
  const ts = rawTs > 1_000_000_000_000 ? Math.floor(rawTs / 1000) : rawTs;

  await sql`
    INSERT INTO message_status (chat_jid, message_id, to_jid, status, ts)
    VALUES (${chatJid}, ${messageId}, ${toJid}, ${status}, ${ts})
    ON CONFLICT (chat_jid, message_id, to_jid, status)
    DO UPDATE SET ts = excluded.ts
  `;
}

export async function listMessageStatus(
  chatJid: string,
  messageId: string,
): Promise<StatusRow[]> {
  return sql<StatusRow[]>`
    SELECT chat_jid, message_id, to_jid, status, ts
    FROM message_status
    WHERE chat_jid = ${chatJid} AND message_id = ${messageId}
    ORDER BY ts ASC
  `;
}

export async function listStatusesForChat(
  chatJid: string,
): Promise<StatusRow[]> {
  return sql<StatusRow[]>`
    SELECT chat_jid, message_id, to_jid, status, ts
    FROM message_status
    WHERE chat_jid = ${chatJid}
    ORDER BY ts ASC
  `;
}

/** Latest status per message in a chat (for read ticks). */
export async function chatStatusSummary(
  chatJid: string,
): Promise<Record<string, string>> {
  const rows = await sql<{ message_id: string; status: string }[]>`
    SELECT DISTINCT ON (message_id) message_id, status
    FROM message_status
    WHERE chat_jid = ${chatJid}
    ORDER BY message_id, ts DESC
  `;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.message_id] = r.status;
  return out;
}
