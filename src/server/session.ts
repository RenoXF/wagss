import { authUser } from '@/auth/middleware';
import { logger } from '@/logger';
import { SessionHolder } from '@/whatsapp';
import { Elysia, t } from 'elysia';

const holder = SessionHolder.getInstance();
const REFRESH_GROUPS_COOLDOWN_MS = 60_000 * 5;
let lastGroupsRefresh = 0;

export const sessionRoutes = new Elysia({ prefix: '/session' })
  .use(authUser)
  .guard({
    beforeHandle({ user, set }) {
      if (!user) {
        set.status = 401;
        return { success: false, message: 'Unauthorized' };
      }
    },
  })
  // Current session status (or 404 if not started)
  .get('/', ({ set }) => {
    const session = holder.get();
    if (!session) {
      set.status = 404;
      return { success: false, message: 'No session, not started' };
    }
    return { success: true, data: session.getStatus() };
  })
  .get('/qr-code', ({ set }) => {
    const session = holder.get();
    if (!session) {
      set.status = 404;
      return { success: false, message: 'Session not found' };
    }
    return {
      success: true,
      data: {
        qrCode: session.getQrCode(),
        pairingCode: session.getPairingCode(),
        hasQrCode: session.getQrCode() !== null,
        hasPairingCode: session.getPairingCode() !== null,
      },
    };
  })
  .post(
    '/start',
    async ({ body, set }) => {
      try {
        const session = await holder.start(body.phoneNumber ?? null);
        return {
          success: true,
          message: 'Session started',
          data: session.getStatus(),
        };
      } catch (err) {
        logger.error({ err }, '[API] Error starting session');
        set.status = 400;
        return {
          success: false,
          message:
            err instanceof Error ? err.message : 'Failed to start session',
        };
      }
    },
    {
      body: t.Object({
        phoneNumber: t.Optional(t.String()),
      }),
    },
  )
  .post('/stop', async ({ set }) => {
    const ok = await holder.stop();
    if (!ok) {
      set.status = 404;
      return { success: false, message: 'No session to stop' };
    }
    return { success: true, message: 'Session stopped' };
  })
  .post('/logout', async ({ set }) => {
    const ok = await holder.logout();
    if (!ok) {
      set.status = 404;
      return { success: false, message: 'No session to logout' };
    }
    return { success: true, message: 'Session logged out and deleted' };
  })
  .post(
    '/set-online',
    async ({ body, set }) => {
      const session = holder.get();
      const socket = session?.getSocket();
      if (!socket) {
        set.status = 400;
        return { success: false, message: 'Session not connected' };
      }
      try {
        await socket.sendPresenceUpdate(
          body.online ? 'available' : 'unavailable',
        );
        return {
          success: true,
          message: `Presence set to ${body.online ? 'online' : 'offline'}`,
        };
      } catch {
        set.status = 500;
        return { success: false, message: 'Failed to update presence' };
      }
    },
    {
      body: t.Object({ online: t.Boolean() }),
    },
  )
  .post('/refresh-groups', async ({ set }) => {
    const session = holder.get();
    const socket = session?.getSocket();
    if (!socket) {
      set.status = 400;
      return { success: false, message: 'Session not connected' };
    }

    const now = Date.now();
    if (now - lastGroupsRefresh < REFRESH_GROUPS_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil(
        (REFRESH_GROUPS_COOLDOWN_MS - (now - lastGroupsRefresh)) / 1000,
      );
      set.status = 429;
      set.headers['Retry-After'] = String(remainingSeconds);
      return {
        success: false,
        message: `Rate limited. Please wait ${remainingSeconds} seconds before refreshing again.`,
      };
    }

    try {
      await socket.groupFetchAllParticipating();
      lastGroupsRefresh = now;
      return { success: true, message: 'Groups refreshed' };
    } catch {
      set.status = 500;
      return { success: false, message: 'Failed to refresh groups' };
    }
  });
