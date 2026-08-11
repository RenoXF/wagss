import { authUser } from '@/auth/middleware';
import { sql } from '@/db/client';
import { SessionHolder } from '@/whatsapp';
import {
  getMessage,
  getUnreadCounts,
  listChatJids,
  listMessages,
  markChatRead,
} from '@/whatsapp/message-store';
import { listChatReactions } from '@/whatsapp/reaction-store';
import { chatStatusSummary, listMessageStatus } from '@/whatsapp/status-store';
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
          body.sendPresence ?? false,
          body.delay ?? 60,
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
        message: t.String({ minLength: 1, maxLength: 4096 }),
        id: t.Optional(t.Nullable(t.String())),
        delay: t.Optional(t.Number({ minimum: 0, maximum: 300 })),
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
          60,
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
        message: t.String({ minLength: 1 }),
        messageKey: t.String({ minLength: 1 }),
      }),
    },
  )
  .post(
    '/delete',
    async ({ body, set }) => {
      try {
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
          60,
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
    async ({ body, set }) => {
      try {
        const whatsapp = getSession();
        const ids = await readReceiptIds(body.jid);
        await markChatRead(body.jid);
        const socket = whatsapp.getSocket();
        if (socket && ids.length > 0) {
          socket.sendReceipt(body.jid, undefined, ids, 'read').catch(() => {});
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
      body: t.Object({ jid: t.String() }),
    },
  )
  .get(
    '/:chatJid/status',
    async ({ params }) => {
      const rows = await sql<{ message_id: string }[]>`
        SELECT DISTINCT message_id FROM message_status
        WHERE chat_jid = ${params.chatJid}
      `;
      const out: Record<string, unknown[]> = {};
      for (const r of rows) {
        out[r.message_id] = await listMessageStatus(
          params.chatJid,
          r.message_id,
        );
      }
      return { success: true, data: out };
    },
    { params: t.Object({ chatJid: t.String({ minLength: 1 }) }) },
  )
  .get(
    '/:chatJid/reactions',
    async ({ params }) => {
      return { success: true, data: await listChatReactions(params.chatJid) };
    },
    { params: t.Object({ chatJid: t.String({ minLength: 1 }) }) },
  );
