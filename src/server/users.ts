import { authUser } from '@/auth/middleware';
import { sql } from '@/db/client';
import { Elysia, t } from 'elysia';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
}

export const usersRoutes = new Elysia({ prefix: '/users' })
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
    const users = await sql<UserRow[]>`
      SELECT id, username, display_name, is_active, created_by, created_at
      FROM users ORDER BY id ASC
    `;
    return { success: true, data: users };
  })
  .patch(
    '/:id',
    async ({ params, body, set }) => {
      const res = await sql`
        UPDATE users
        SET display_name = COALESCE(${body.displayName ?? null}, display_name),
            is_active = COALESCE(${body.isActive ?? null}, is_active)
        WHERE id = ${params.id}
      `;
      if (res.count === 0) {
        set.status = 404;
        return { success: false, message: 'User not found' };
      }
      return { success: true };
    },
    {
      params: t.Object({ id: t.Numeric() }),
      body: t.Object({
        displayName: t.Optional(t.String({ minLength: 1 })),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete(
    '/:id',
    async ({ params, user, set }) => {
      if (user && params.id === user.userId) {
        set.status = 400;
        return { success: false, message: 'Cannot delete yourself' };
      }
      const res = await sql`DELETE FROM users WHERE id = ${params.id}`;
      if (res.count === 0) {
        set.status = 404;
        return { success: false, message: 'User not found' };
      }
      return { success: true };
    },
    {
      params: t.Object({ id: t.Numeric() }),
    },
  );
