import { authUser } from '@/auth/middleware';
import {
  getContact,
  listContacts,
  resolveDisplayName,
} from '@/whatsapp/contact-store';
import { listChatJids } from '@/whatsapp/message-store';
import { Elysia, t } from 'elysia';

export const contactRoutes = new Elysia({ prefix: '/contacts' })
  .use(authUser)
  .guard({
    beforeHandle({ user, set }) {
      if (!user) {
        set.status = 401;
        return { success: false, message: 'Unauthorized' };
      }
    },
  })
  .get('/', async () => {
    const [contacts, chats] = await Promise.all([
      listContacts(),
      listChatJids(500),
    ]);
    const chatByJid = new Map(chats.map((c) => [c.chatJid, c]));
    const data = await Promise.all(
      contacts.map(async (c) => ({
        ...c,
        displayName: await resolveDisplayName(c.jid),
        lastMessage: chatByJid.get(c.jid)?.lastMessage ?? null,
        lastTimestamp: chatByJid.get(c.jid)?.lastTimestamp ?? 0,
        messageCount: chatByJid.get(c.jid)?.count ?? 0,
      })),
    );
    return { success: true, data };
  })
  .get(
    '/:jid',
    async ({ params, set }) => {
      const contact = await getContact(params.jid);
      if (!contact) {
        set.status = 404;
        return { success: false, message: 'Contact not found' };
      }
      return {
        success: true,
        data: {
          ...contact,
          displayName: await resolveDisplayName(params.jid),
        },
      };
    },
    { params: t.Object({ jid: t.String({ minLength: 1 }) }) },
  )
  // Proxy profile picture from imgUrl when present.
  .get(
    '/:jid/avatar',
    async ({ params, set }) => {
      const contact = await getContact(params.jid);
      const url = contact?.img_url ?? contact?.avatar_url;
      if (!url) {
        set.status = 404;
        return { success: false, message: 'No avatar' };
      }
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          set.status = 400;
          return { success: false, message: 'Invalid avatar URL' };
        }
        const hostname = parsed.hostname.toLowerCase();
        const isPrivate =
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '::1' ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
          hostname === '169.254.169.254' ||
          hostname.endsWith('.internal');
        if (isPrivate) {
          set.status = 403;
          return { success: false, message: 'Avatar host not allowed' };
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'WAGSS/1.0' },
        });
        clearTimeout(timeout);
        if (!res.ok) {
          set.status = 404;
          return { success: false, message: 'Avatar unavailable' };
        }
        const contentLength = res.headers.get('content-length');
        if (contentLength && Number(contentLength) > 5 * 1024 * 1024) {
          set.status = 413;
          return { success: false, message: 'Avatar too large' };
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 5 * 1024 * 1024) {
          set.status = 413;
          return { success: false, message: 'Avatar too large' };
        }
        set.headers['Content-Type'] =
          res.headers.get('content-type') ?? 'image/jpeg';
        set.headers['Cache-Control'] = 'public, max-age=86400';
        return buf;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          set.status = 504;
          return { success: false, message: 'Avatar fetch timeout' };
        }
        set.status = 404;
        return { success: false, message: 'Avatar unavailable' };
      }
    },
    { params: t.Object({ jid: t.String({ minLength: 1 }) }) },
  );
