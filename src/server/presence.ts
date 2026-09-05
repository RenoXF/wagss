import { authUser } from '@/auth/middleware';
import { SessionHolder } from '@/whatsapp';
import { Elysia, t } from 'elysia';

const holder = SessionHolder.getInstance();

export const presenceRoutes = new Elysia({ prefix: '/presence' })
  .use(authUser)
  .guard({
    beforeHandle({ user, set }) {
      if (!user) {
        set.status = 401;
        return { success: false, message: 'Unauthorized' };
      }
    },
  })
  .post(
    '/typing',
    async ({ body, user, set }) => {
      const session = holder.get();
      const socket = session?.getSocket();
      if (!socket) {
        set.status = 400;
        return { success: false, message: 'Session not connected' };
      }
      try {
        const rawPresence = (body as { presence?: string }).presence;
        const allowed = new Set(['composing', 'paused', 'recording']);
        let presenceToSend: 'composing' | 'paused' | 'recording';
        if (rawPresence && allowed.has(rawPresence)) {
          presenceToSend = rawPresence as 'composing' | 'paused' | 'recording';
        } else {
          presenceToSend = body.typing ? 'composing' : 'paused';
        }
        await socket
          .sendPresenceUpdate(presenceToSend, body.jid)
          .catch((err) => console.error('typing presence error:', err));
        // Broadcast to other web operators (UI↔UI).
        const { WhatsAppSession } = await import('@/whatsapp');
        WhatsAppSession.emitToSse(
          JSON.stringify({
            type: 'typing',
            data: {
              chatJid: body.jid,
              username: user?.username ?? 'unknown',
              typing: body.typing,
              presence: presenceToSend,
            },
          }),
        );
        return { success: true };
      } catch {
        set.status = 500;
        return { success: false, message: 'Failed to update presence' };
      }
    },
    {
      body: t.Object({
        jid: t.String({ minLength: 1 }),
        typing: t.Boolean(),
        presence: t.Optional(
          t.Union([
            t.Literal('composing'),
            t.Literal('paused'),
            t.Literal('recording'),
          ]),
        ),
      }),
    },
  );
