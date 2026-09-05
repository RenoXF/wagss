import { authUser } from '@/auth/middleware';
import { sql } from '@/db/client';
import { logEvent } from '@/db/log';
import { Elysia, t } from 'elysia';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  is_active: boolean;
  role: string;
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
      SELECT id, username, display_name, is_active, role, created_by, created_at
      FROM users ORDER BY id ASC
    `;
    return { success: true, data: users };
  })
  .patch(
    '/:id',
    async ({ params, body, user, set }) => {
      if (user?.role !== 'admin') {
        set.status = 403;
        return { success: false, message: 'Forbidden: admin only' };
      }
      // Prevent deactivating last admin
      if (body.isActive === false || body.role === 'user') {
        const admins = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM users WHERE role = 'admin' AND is_active = true
        `;
        const adminCount = Number(admins[0]?.count ?? 0);
        const target = await sql<UserRow[]>`
          SELECT role, is_active FROM users WHERE id = ${params.id} LIMIT 1
        `;
        if (target[0]?.role === 'admin' && target[0]?.is_active) {
          if (adminCount <= 1) {
            set.status = 400;
            return { success: false, message: 'Cannot deactivate last admin' };
          }
        }
      }
      const res = await sql`
        UPDATE users
        SET display_name = COALESCE(${body.displayName ?? null}, display_name),
            is_active = COALESCE(${body.isActive ?? null}, is_active),
            role = COALESCE(${body.role ?? null}, role)
        WHERE id = ${params.id}
      `;
      if (res.count === 0) {
        set.status = 404;
        return { success: false, message: 'User not found' };
      }
      void logEvent(
        'users',
        'patch',
        'info',
        { targetId: params.id, body, by: user?.username },
        null,
      );
      return { success: true };
    },
    {
      params: t.Object({ id: t.Numeric() }),
      body: t.Object({
        displayName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        isActive: t.Optional(t.Boolean()),
        role: t.Optional(t.Union([t.Literal('admin'), t.Literal('user')])),
      }),
    },
  )
  .delete(
    '/:id',
    async ({ params, user, set }) => {
      if (user?.role !== 'admin') {
        set.status = 403;
        return { success: false, message: 'Forbidden: admin only' };
      }
      if (user && params.id === user.userId) {
        set.status = 400;
        return { success: false, message: 'Cannot delete yourself' };
      }
      const res = await sql`DELETE FROM users WHERE id = ${params.id}`;
      if (res.count === 0) {
        set.status = 404;
        return { success: false, message: 'User not found' };
      }
      void logEvent(
        'users',
        'delete',
        'info',
        { targetId: params.id, by: user?.username },
        null,
      );
      return { success: true };
    },
    {
      params: t.Object({ id: t.Numeric() }),
    },
  );
