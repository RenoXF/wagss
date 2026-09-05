import { authUser } from '@/auth/middleware';
import { sql } from '@/db/client';
import { SessionHolder } from '@/whatsapp';
import {
  getMessage,
  getUnreadCounts,
  isOwnMessage,
  listChatJids,
  listMessages,
  markChatRead,
  searchMessages,
  starMessage,
} from '@/whatsapp/message-store';
import { listChatReactions } from '@/whatsapp/reaction-store';
import {
  chatStatusSummary,
  listMessageStatus,
  listStatusesForChat,
} from '@/whatsapp/status-store';
import { isJidGroup, isLidUser, isPnUser } from 'baileys';
import { Elysia, t } from 'elysia';

const holder = SessionHolder.getInstance();

const getSession = () => {
  const session = holder.get();
  if (!session) throw new Error('WhatsApp not connected, please start first');
  return session;
};

const validateJid = (jid: string) => {
  if (!(isJidGroup(jid) || isPnUser(jid) || isLidUser(jid))) {
    throw new Error('Invalid recipient JID');
  }
  if (jid.startsWith('+')) {
    throw new Error('Invalid recipient JID, must not include "+"');
  }
};

const readReceiptIds = async (chatJid: string): Promise<string[]> => {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM messages
    WHERE chat_jid = ${chatJid} AND from_me = false AND read_at IS NULL
    ORDER BY timestamp ASC
  `;
  return rows.map((r) => r.id.split('-').pop() as string);
};

export const messageRoutes = new Elysia({ prefix: '/messages' })
  .use(authUser)
  .guard({
    beforeHandle({ user, set }) {
      if (!user) {
        set.status = 401;
        return { success: false, message: 'Unauthorized' };
      }
    },
  })
  .get('/', async ({ query, set }) => {
    try {
      const chats = await listChatJids(Number(query.limit ?? 200));
      const unread = await getUnreadCounts();
      const unreadMap = new Map(unread.map((u) => [u.chat_jid, u.unread]));
      const data = chats.map((c) => ({
        ...c,
        unreadCount: unreadMap.get(c.chatJid) ?? 0,
      }));
      return { success: true, data };
    } catch (err) {
      set.status = 500;
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Failed to list chats',
      };
    }
  })
  .get(
    '/search',
    async ({ query, set }) => {
      try {
        const q = String(query.q ?? '').trim();
        if (!q) {
          return { success: true, data: [] };
        }
        const rows = await searchMessages(
          q,
          Number(query.offset ?? 0),
          Number(query.limit ?? 50),
        );
        return { success: true, data: rows };
      } catch (err) {
        set.status = 500;
        return {
          success: false,
          message: err instanceof Error ? err.message : 'Search failed',
        };
      }
    },
    {
      query: t.Object({
        q: t.String({ minLength: 1 }),
        limit: t.Optional(t.Number({ default: 50, maximum: 200 })),
        offset: t.Optional(t.Number({ default: 0 })),
      }),
    },
  )
  .get(
    '/:chatJid',
    async ({ params, query, set }) => {
      try {
        const messages = await listMessages(
          params.chatJid,
          Number(query.limit ?? 50),
          Number(query.offset ?? 0),
        );
        return { success: true, data: messages };
      } catch (err) {
        set.status = 500;
        return {
          success: false,
          message:
            err instanceof Error ? err.message : 'Failed to list messages',
        };
      }
    },
    {
      params: t.Object({ chatJid: t.String({ minLength: 1 }) }),
      query: t.Object({
        limit: t.Optional(t.Number({ default: 50, maximum: 200 })),
        offset: t.Optional(t.Number({ default: 0 })),
      }),
    },
  )
  .post(
    '/send-text',
    async ({ body, user, set }) => {
      try {
        const whatsapp = getSession();
        validateJid(body.recipient);
        await whatsapp.sendMessage(
          body.recipient,
          { text: body.message },
          undefined,
          false,
          user
            ? { sentBy: user.username, senderName: user.displayName }
            : undefined,
        );
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({
        recipient: t.String({ minLength: 1 }),
        message: t.String({ minLength: 1, maxLength: 65536 }),
        id: t.Optional(t.Nullable(t.String())),
        sendPresence: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/send-reply',
    async ({ body, user, set }) => {
      try {
        const whatsapp = getSession();
        validateJid(body.recipient);
        const raw = await getMessage(body.messageKey);
        const original = raw?.message as { message?: unknown } | undefined;
        if (!original?.message) {
          set.status = 404;
          return { success: false, message: 'Original message not found' };
        }
        await whatsapp.sendMessage(
          body.recipient,
          {
            text: body.message,
            contextInfo: { quotedMessage: original.message as never },
          },
          undefined,
          false,
          user
            ? { sentBy: user.username, senderName: user.displayName }
            : undefined,
        );
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({
        recipient: t.String({ minLength: 1 }),
        message: t.String({ minLength: 1, maxLength: 65536 }),
        messageKey: t.String({ minLength: 1 }),
      }),
    },
  )
  .post(
    '/send-media',
    async ({ body, user, set }) => {
      try {
        const whatsapp = getSession();
        validateJid(body.recipient);
        const attribution = user
          ? { sentBy: user.username, senderName: user.displayName }
          : undefined;
        const MAX_SIZE = 50 * 1024 * 1024;
        const files = Array.isArray(body.files) ? body.files : [body.files];
        if (files.length === 0) {
          set.status = 400;
          return { success: false, message: 'No files provided' };
        }
        for (const f of files) {
          if (f.size > MAX_SIZE) {
            set.status = 413;
            return {
              success: false,
              message: `File "${f.name}" exceeds 50MB limit`,
            };
          }
        }
        const mediaPool: {
          image?: Buffer;
          video?: Buffer;
          caption?: string;
        }[] = [];
        const docPool: {
          buffer: Buffer;
          fileName: string;
          mimetype: string;
          caption?: string;
        }[] = [];
        for (const f of files) {
          const buf = Buffer.from(await f.arrayBuffer());
          const mime = f.type || 'application/octet-stream';
          if (mime.startsWith('image/') || mime.startsWith('video/')) {
            mediaPool.push({
              ...(mime.startsWith('image/') ? { image: buf } : { video: buf }),
              caption: mediaPool.length === 0 ? body.caption : undefined,
            });
          } else {
            docPool.push({
              buffer: buf,
              fileName: f.name || 'document',
              mimetype: mime,
              caption:
                docPool.length === 0 && mediaPool.length === 0
                  ? body.caption
                  : undefined,
            });
          }
        }
        if (mediaPool.length > 0) {
          for (let i = 0; i < mediaPool.length; i++) {
            const m = mediaPool[i];
            if (!m) continue;
            if (i === 0 && body.caption) {
              m.caption = body.caption;
            }
            await whatsapp.sendMessage(
              body.recipient,
              m as any,
              undefined,
              false,
              attribution,
            );
          }
        }
        for (const d of docPool) {
          await whatsapp.sendMessage(
            body.recipient,
            {
              document: d.buffer,
              fileName: d.fileName,
              mimetype: d.mimetype,
              caption: d.caption,
            },
            undefined,
            false,
            attribution,
          );
        }
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({
        recipient: t.String({ minLength: 1 }),
        caption: t.Optional(t.String({ maxLength: 1024 })),
        files: t.Union([
          t.File({ maxSize: 50 * 1024 * 1024 }),
          t.Array(t.File({ maxSize: 50 * 1024 * 1024 }), {
            minItems: 1,
            maxItems: 10,
          }),
        ]),
      }),
    },
  )
  .post(
    '/delete',
    async ({ body, set }) => {
      try {
        if (!(await isOwnMessage(body.jid, body.messageId))) {
          set.status = 403;
          return {
            success: false,
            message: 'Only own outgoing messages can be deleted',
          };
        }
        const whatsapp = getSession();
        const socket = whatsapp.getSocket();
        if (!socket) {
          set.status = 400;
          return { success: false, message: 'Session not connected' };
        }
        await socket.sendMessage(body.jid, {
          delete: {
            id: body.messageId,
            remoteJid: body.jid,
            fromMe: true,
          },
        });
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({ jid: t.String(), messageId: t.String() }),
    },
  )
  .post(
    '/edit',
    async ({ body, set }) => {
      try {
        if (!(await isOwnMessage(body.jid, body.messageId))) {
          set.status = 403;
          return {
            success: false,
            message: 'Only own messages can be edited',
          };
        }
        const whatsapp = getSession();
        const socket = whatsapp.getSocket();
        if (!socket) {
          set.status = 400;
          return { success: false, message: 'Session not connected' };
        }
        await socket.sendMessage(body.jid, {
          text: body.message,
          edit: { id: body.messageId, remoteJid: body.jid, fromMe: true },
        });
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({
        jid: t.String({ minLength: 1 }),
        messageId: t.String({ minLength: 1 }),
        message: t.String({ minLength: 1, maxLength: 4096 }),
      }),
    },
  )
  .post(
    '/star',
    async ({ body, set }) => {
      try {
        await starMessage(body.jid, body.messageId, body.star);
        const whatsapp = getSession();
        const socket = whatsapp.getSocket();
        if (socket) {
          socket
            .star(body.jid, [{ id: body.messageId, fromMe: true }], body.star)
            .catch(() => {});
        }
        const { WhatsAppSession } = await import('@/whatsapp');
        WhatsAppSession.emitToSse(
          JSON.stringify({
            type: 'message_starred',
            data: {
              chatJid: body.jid,
              messageId: body.messageId,
              star: body.star,
            },
          }),
        );
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({
        jid: t.String({ minLength: 1 }),
        messageId: t.String({ minLength: 1 }),
        star: t.Boolean(),
      }),
    },
  )
  .post(
    '/forward',
    async ({ body, user, set }) => {
      try {
        const whatsapp = getSession();
        validateJid(body.targetJid);
        const raw = await getMessage(body.messageKey);
        if (!raw?.message) {
          set.status = 404;
          return { success: false, message: 'Message not found' };
        }
        await whatsapp.sendMessage(
          body.targetJid,
          { forward: raw.message as any },
          undefined,
          false,
          user
            ? { sentBy: user.username, senderName: user.displayName }
            : undefined,
        );
        return { success: true };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({
        targetJid: t.String({ minLength: 1 }),
        messageKey: t.String({ minLength: 1 }),
      }),
    },
  )
  .post(
    '/read',
    async ({ body, user, set }) => {
      try {
        await markChatRead(body.jid);
        const { WhatsAppSession } = await import('@/whatsapp');
        const { logEvent } = await import('@/db/log');
        WhatsAppSession.emitToSse(
          JSON.stringify({
            type: 'chat_read',
            data: {
              jid: body.jid,
              readBy: user?.username ?? null,
              whatsapp: !!body.whatsapp,
            },
          }),
        );
        void logEvent(
          'api',
          'read',
          'info',
          { jid: body.jid, whatsapp: !!body.whatsapp, by: user?.username },
          null,
        );
        if (body.whatsapp) {
          const whatsapp = getSession();
          const ids = await readReceiptIds(body.jid);
          const socket = whatsapp.getSocket();
          if (socket && ids.length > 0) {
            socket.sendReceipt(body.jid, undefined, ids, 'read').catch((e) => {
              void logEvent(
                'baileys',
                'sendReceipt',
                'error',
                { jid: body.jid, ids },
                String(e),
              );
            });
          }
        }
        return { success: true };
      } catch (err) {
        const { logEvent } = await import('@/db/log');
        void logEvent(
          'api',
          'read',
          'error',
          { jid: (body as { jid?: unknown })?.jid },
          String(err),
        );
        set.status = 400;
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    {
      body: t.Object({ jid: t.String(), whatsapp: t.Optional(t.Boolean()) }),
    },
  )
  .get(
    '/:chatJid/status/:messageId',
    async ({ params }) => {
      const data = await listMessageStatus(params.chatJid, params.messageId);
      return { success: true, data };
    },
    {
      params: t.Object({
        chatJid: t.String({ minLength: 1 }),
        messageId: t.String({ minLength: 1 }),
      }),
    },
  )
  .get(
    '/:chatJid/:messageId/status',
    async ({ params }) => {
      const data = await listMessageStatus(params.chatJid, params.messageId);
      return { success: true, data };
    },
    {
      params: t.Object({
        chatJid: t.String({ minLength: 1 }),
        messageId: t.String({ minLength: 1 }),
      }),
    },
  )
  .get(
    '/:chatJid/status',
    async ({ params, query }) => {
      // Per-message on-demand fetch keeps client simple; bulk uses single query
      if (query?.messageId) {
        const data = await listMessageStatus(params.chatJid, query.messageId);
        return { success: true, data };
      }
      const rows = await listStatusesForChat(params.chatJid);
      const out: Record<string, typeof rows> = {};
      for (const r of rows) {
        (out[r.message_id] ??= []).push(r);
      }
      return { success: true, data: out };
    },
    {
      params: t.Object({ chatJid: t.String({ minLength: 1 }) }),
      query: t.Object({ messageId: t.Optional(t.String({ minLength: 1 })) }),
    },
  )
  .get(
    '/:chatJid/reactions',
    async ({ params }) => {
      return { success: true, data: await listChatReactions(params.chatJid) };
    },
    { params: t.Object({ chatJid: t.String({ minLength: 1 }) }) },
  );
