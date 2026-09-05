import { sql } from '@/db/client';
import { BufferJSON } from 'baileys';

/**
 * Postgres-backed message store for the single WhatsApp account.
 * Persists every message (incoming + outgoing); id = `${chatJid}-${key.id}`.
 */

export interface ChatSummary {
  chatJid: string;
  lastMessage: unknown;
  count: number;
  lastTimestamp: number;
}

export const msgId = (chatJid: string, keyId: string) => `${chatJid}-${keyId}`;

export type Row = {
  id: string;
  chat_jid: string;
  from_me: boolean;
  sender_jid: string | null;
  sender_name: string | null;
  sent_by_user: string | null;
  message: unknown;
  timestamp: number;
  read_at: Date | null;
  media_path: string | null;
  media_type: string | null;
  media_mime_type: string | null;
  device: string | null;
  starred: boolean;
  original_text: string | null;
  original_message: unknown;
  edited_at: number | null;
  original_message_id: string | null;
};

/** Extract a normalized text payload from a Baileys proto message. */
export function extractText(msg: any): string {
  const m = msg?.message;
  if (!m) {
    // Handle stub/system messages (e.g., old counter, decryption failure)
    if (msg?.messageStubType != null) {
      const p = msg?.messageStubParameters?.[0] as string | undefined;
      if (p?.includes('old counter')) return '🔒 Pesan terenkripsi';
      if (p) return p;
      return '🔒 Pesan sistem';
    }
    return '';
  }
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption || '';
  if (m.videoMessage?.caption) return m.videoMessage.caption || '';
  if (m.documentMessage?.caption) return m.documentMessage.caption || '';
  if (m.ephemeralMessage?.message)
    return extractText(m.ephemeralMessage.message);
  if (m.messageStubType != null) {
    const p = (m as any).messageStubParameters?.[0] as string | undefined;
    if (p?.includes('old counter')) return '🔒 Pesan terenkripsi';
    if (p) return p;
    return '🔒 Pesan sistem';
  }
  return '';
}

/** Detect sender device from Baileys message id patterns (official getDevice). */
export function detectDevice(id: string): string {
  if (!id) return 'unknown';
  if (/^3A.{18}$/.test(id)) return 'ios';
  if (/^3E.{20}$/.test(id)) return 'web';
  if (/^(.{21}|.{32})$/.test(id)) return 'android';
  if (/^3F.{18}$/.test(id)) return 'desktop';
  if (/^.{18}$/.test(id)) return 'desktop';
  return 'unknown';
}

export type MediaMeta = {
  media_type: string | null;
  media_mime_type: string | null;
  media_size: number | null;
  media_duration: number | null;
  media_width: number | null;
  media_height: number | null;
  view_once: boolean;
};

/** Pull media metadata (type, mime, size, dims) off a Baileys message. */
export function extractMediaMeta(msg: any): MediaMeta {
  let m: any = msg?.message;
  if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m?.documentWithCaptionMessage?.message)
    m = m.documentWithCaptionMessage.message;
  const patch: MediaMeta = {
    media_type: null,
    media_mime_type: null,
    media_size: null,
    media_duration: null,
    media_width: null,
    media_height: null,
    view_once: false,
  };
  if (!m) return patch;
  const pick: Record<string, (...a: any[]) => void> = {
    imageMessage(m2: any) {
      patch.media_type = 'image';
      patch.media_mime_type = m2.mimetype ?? null;
      patch.media_size = m2.fileLength ?? null;
      patch.media_width = m2.width ?? null;
      patch.media_height = m2.height ?? null;
      patch.view_once = !!m2.viewOnce;
    },
    videoMessage(m2: any) {
      patch.media_type = 'video';
      patch.media_mime_type = m2.mimetype ?? null;
      patch.media_size = m2.fileLength ?? null;
      patch.media_duration = m2.seconds ?? null;
      patch.media_width = m2.width ?? null;
      patch.media_height = m2.height ?? null;
      patch.view_once = !!m2.viewOnce;
    },
    audioMessage(m2: any) {
      patch.media_type = 'audio';
      patch.media_mime_type = m2.mimetype ?? null;
      patch.media_size = m2.fileLength ?? null;
      patch.media_duration = m2.seconds ?? null;
    },
    documentMessage(m2: any) {
      patch.media_type = 'document';
      patch.media_mime_type = m2.mimetype ?? null;
      patch.media_size = m2.fileLength ?? null;
    },
    stickerMessage(m2: any) {
      patch.media_type = 'sticker';
      patch.media_mime_type = m2.mimetype ?? null;
      patch.media_size = m2.fileLength ?? null;
    },
  };
  for (const type of Object.keys(pick)) {
    if (m[type]) (pick[type] as (v: any) => void)(m[type]);
  }
  const orig = msg?.message;
  if (
    orig?.viewOnceMessage ||
    orig?.viewOnceMessageV2 ||
    orig?.ephemeralMessage?.message?.viewOnceMessage ||
    orig?.ephemeralMessage?.message?.viewOnceMessageV2
  )
    patch.view_once = true;
  return patch;
}

/** Extract full message metadata for storage columns. */
export function extractMessageMeta(msg: any) {
  const message_type = Object.keys(msg?.message ?? {})[0] ?? null;
  let mm: any = msg?.message;
  if (mm?.ephemeralMessage?.message) mm = mm.ephemeralMessage.message;
  if (mm?.viewOnceMessage?.message) mm = mm.viewOnceMessage.message;
  if (mm?.viewOnceMessageV2?.message) mm = mm.viewOnceMessageV2.message;
  if (mm?.documentWithCaptionMessage?.message)
    mm = mm.documentWithCaptionMessage.message;
  const quoted =
    msg?.message?.extendedTextMessage?.contextInfo ??
    mm?.imageMessage?.contextInfo ??
    mm?.videoMessage?.contextInfo ??
    mm?.audioMessage?.contextInfo ??
    mm?.documentMessage?.contextInfo ??
    mm?.stickerMessage?.contextInfo ??
    null;
  return {
    message_type: message_type?.replace('Message', '') ?? null,
    message_text: extractText(msg) || null,
    device: detectDevice(msg?.key?.id ?? ''),
    forwarded: !!quoted?.isForwarded,
    quoted_message_id:
      (quoted?.stanzaId === '' ? null : quoted?.stanzaId) ?? null,
    ...extractMediaMeta(msg),
  };
}

export async function upsertMessage(
  msg: any,
  meta: { senderName?: string | null; sentByUser?: string | null } = {},
): Promise<void> {
  if (!msg?.key?.id || !msg?.key?.remoteJid) return;
  const storeId = msgId(msg.key.remoteJid, msg.key.id);
  const senderJid =
    msg.key.participant ?? (msg.key.fromMe ? null : msg.key.remoteJid);
  const serialized = JSON.stringify({ ...msg }, BufferJSON.replacer as never);
  const m = extractMessageMeta(msg);
  await sql`
    INSERT INTO messages (id, chat_jid, from_me, sender_jid, sender_name, sent_by_user, message, timestamp,
      message_type, message_text, device, forwarded, quoted_message_id,
      media_type, media_mime_type, media_size, media_duration, media_width, media_height, view_once)
    VALUES (
      ${storeId}, ${msg.key.remoteJid}, ${!!msg.key.fromMe},
      ${senderJid ?? null}, ${meta.senderName ?? null}, ${meta.sentByUser ?? null},
      ${serialized}::jsonb, ${msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()},
      ${m.message_type}, ${m.message_text ?? null}, ${m.device}, ${m.forwarded ?? false}, ${m.quoted_message_id},
      ${m.media_type}, ${m.media_mime_type ?? null}, ${m.media_size}, ${m.media_duration}, ${m.media_width}, ${m.media_height}, ${m.view_once ?? false}
    )
    ON CONFLICT (id) DO UPDATE SET
      message = CASE WHEN messages.edited_at IS NOT NULL THEN messages.message ELSE excluded.message END,
      message_text = CASE WHEN messages.edited_at IS NOT NULL THEN messages.message_text ELSE excluded.message_text END,
      sender_name = COALESCE(excluded.sender_name, messages.sender_name),
      sent_by_user = COALESCE(excluded.sent_by_user, messages.sent_by_user)
  `;
}

export async function setMediaPath(
  storeId: string,
  mediaPath: string,
): Promise<void> {
  await sql`UPDATE messages SET media_path = ${mediaPath} WHERE id = ${storeId}`;
}

/** Mark message deleted (protocolMessage REVOKE). */
export async function markMessageDeleted(
  chatJid: string,
  messageId: string,
): Promise<void> {
  await sql`
    UPDATE messages SET deleted = true
    WHERE id = ${msgId(chatJid, messageId)}
  `;
}

/** Apply a message edit (protocolMessage MESSAGE_EDIT). newMsg = full WAMessage. */
export async function updateMessageEdited(
  chatJid: string,
  targetMessageId: string,
  newMsg: any,
): Promise<void> {
  const serialized = JSON.stringify(
    { ...newMsg },
    BufferJSON.replacer as never,
  );
  const m = extractMessageMeta(newMsg);
  await sql`
    UPDATE messages SET
      deleted = false,
      original_text = COALESCE(original_text, message_text),
      original_message = COALESCE(original_message, message),
      message = ${serialized}::jsonb,
      message_text = ${m.message_text},
      edited_at = ${newMsg.messageTimestamp ? Number(newMsg.messageTimestamp) * 1000 : Date.now()},
      original_message_id = ${targetMessageId}
    WHERE id = ${msgId(chatJid, targetMessageId)}
  `;
}

export async function getMessage(storeId: string): Promise<Row | null> {
  const rows = await sql<Row[]>`
    SELECT * FROM messages WHERE id = ${storeId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.message && typeof row.message === 'string') {
    row.message = JSON.parse(row.message, BufferJSON.reviver as never);
  }
  return row;
}

export async function listMessages(
  chatJid: string,
  limit = 50,
  offset = 0,
): Promise<Row[]> {
  const rows = await sql<Row[]>`
    SELECT * FROM messages
    WHERE chat_jid = ${chatJid}
    ORDER BY timestamp DESC, created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map((row) => {
    if (row.message && typeof row.message === 'string') {
      row.message = JSON.parse(row.message, BufferJSON.reviver as never);
    }
    return row;
  });
}

export async function listChatJids(limit = 200): Promise<ChatSummary[]> {
  const rows = await sql<
    {
      chat_jid: string;
      count: number;
      last_ts: number;
      last_message: unknown;
    }[]
  >`
    SELECT m.chat_jid,
           count(*) AS count,
           max(m.timestamp) AS last_ts,
            (SELECT message FROM messages m2
             WHERE m2.chat_jid = m.chat_jid
             ORDER BY m2.timestamp DESC, m2.created_at DESC, m2.id DESC LIMIT 1) AS last_message
    FROM messages m
    GROUP BY m.chat_jid
    ORDER BY last_ts DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    chatJid: r.chat_jid,
    count: Number(r.count),
    lastTimestamp: Number(r.last_ts),
    lastMessage:
      typeof r.last_message === 'string'
        ? JSON.parse(r.last_message, BufferJSON.reviver as never)
        : r.last_message,
  }));
}

export async function markChatRead(chatJid: string): Promise<void> {
  await sql`
    UPDATE messages SET read_at = now()
    WHERE chat_jid = ${chatJid} AND from_me = ${false} AND read_at IS NULL
  `;
}

export async function getUnreadCounts(): Promise<
  { chat_jid: string; unread: number }[]
> {
  return sql<{ chat_jid: string; unread: number }[]>`
    SELECT chat_jid, count(*)::int AS unread FROM messages
    WHERE from_me = ${false} AND read_at IS NULL
    GROUP BY chat_jid
  `;
}

/** Full-text-ish search over stored message text (case-insensitive). */
export async function searchMessages(
  q: string,
  offset = 0,
  limit = 50,
): Promise<Row[]> {
  if (!q.trim()) return [];
  const safe = q
    .trim()
    .replaceAll('!', '!!')
    .replaceAll('%', '!%')
    .replaceAll('_', '!_');
  const rows = await sql<Row[]>`
    SELECT * FROM messages
    WHERE message_text IS NOT NULL
      AND lower(message_text) LIKE '%' || lower(${safe}) || '%' ESCAPE '!'
    ORDER BY timestamp DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map((row) => {
    if (row.message && typeof row.message === 'string') {
      row.message = JSON.parse(row.message, BufferJSON.reviver as never);
    }
    return row;
  });
}

/** Star / unstar a message. */
export async function starMessage(
  chatJid: string,
  messageId: string,
  star: boolean,
): Promise<void> {
  await sql`
    UPDATE messages SET starred = ${star}
    WHERE id = ${msgId(chatJid, messageId)}
  `;
}

/** Check whether a message exists and belongs to us (fromMe). */
export async function isOwnMessage(
  chatJid: string,
  messageId: string,
): Promise<boolean> {
  const rows = await sql<{ from_me: boolean }[]>`
    SELECT from_me FROM messages WHERE id = ${msgId(chatJid, messageId)} LIMIT 1
  `;
  return rows.length > 0 && !!rows[0]?.from_me;
}
