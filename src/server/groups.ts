import { authUser } from '@/auth/middleware';
import {
  getGroup,
  listGroupParticipants,
  listGroups,
} from '@/whatsapp/group-store';
import { Elysia, t } from 'elysia';

export const groupRoutes = new Elysia({ prefix: '/groups' })
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
    return { success: true, data: await listGroups() };
  })
  .get(
    '/:id',
    async ({ params, set }) => {
      const g = await getGroup(params.id);
      if (!g) {
        set.status = 404;
        return { success: false, message: 'Group not found' };
      }
      return { success: true, data: g };
    },
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
  .get(
    '/:id/participants',
    async ({ params }) => {
      return {
        success: true,
        data: await listGroupParticipants(params.id),
      };
    },
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  );
