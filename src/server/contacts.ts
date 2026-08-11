import { authUser } from '@/auth/middleware';
import { getContact, listContacts } from '@/whatsapp/contact-store';
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
    const data = contacts.map((c) => ({
      ...c,
      lastMessage: chatByJid.get(c.jid)?.lastMessage ?? null,
      lastTimestamp: chatByJid.get(c.jid)?.lastTimestamp ?? 0,
      messageCount: chatByJid.get(c.jid)?.count ?? 0,
    }));
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
      return { success: true, data: contact };
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
        const res = await fetch(url);
        if (!res.ok) {
          set.status = 404;
          return { success: false, message: 'Avatar unavailable' };
        }
        set.headers['Content-Type'] =
          res.headers.get('content-type') ?? 'image/jpeg';
        return res.arrayBuffer();
      } catch {
        set.status = 404;
        return { success: false, message: 'Avatar unavailable' };
      }
    },
    { params: t.Object({ jid: t.String({ minLength: 1 }) }) },
  );
