import { JWT_COOKIE } from '@/auth/jwt';
import { authUser, cookieHeader, signToken } from '@/auth/middleware';
import { hashPassword, verifyPassword } from '@/auth/password';
import { sql } from '@/db/client';
import { Elysia, t } from 'elysia';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_active: boolean;
}

const firstUserExists = async (): Promise<boolean> => {
  const rows = await sql<
    { c: string }[]
  >`SELECT count(*)::text AS c FROM users`;
  return Number(rows[0]?.c ?? 0) > 0;
};

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(authUser)
  .post(
    '/login',
    async ({ body, set }) => {
      const users = await sql<UserRow[]>`
        SELECT id, username, display_name, password_hash, is_active
        FROM users WHERE username = ${body.username} LIMIT 1
      `;
      const user = users[0];
      if (
        !user ||
        !user.is_active ||
        !(await verifyPassword(body.password, user.password_hash))
      ) {
        set.status = 401;
        return { success: false, message: 'Invalid username or password' };
      }

      const payload = {
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
      };
      const token = await signToken(payload);
      set.headers['set-cookie'] = cookieHeader(JWT_COOKIE, token);

      return { success: true, data: payload };
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1 }),
        password: t.String({ minLength: 1 }),
      }),
    },
  )
  .post('/logout', ({ set }) => {
    set.headers['set-cookie'] = cookieHeader(JWT_COOKIE, '', 0);
    return { success: true };
  })
  .get('/me', async ({ user }) => {
    return {
      success: true,
      data: user ?? null,
      setupNeeded: !(await firstUserExists()),
    };
  })
  .use(
    new Elysia()
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
        '/register',
        async ({ body, user, set }) => {
          const taken = await sql<{ id: number }[]>`
            SELECT id FROM users WHERE username = ${body.username} LIMIT 1
          `;
          if (taken.length > 0) {
            set.status = 409;
            return { success: false, message: 'Username already exists' };
          }
          const passwordHash = await hashPassword(body.password);
          await sql`
            INSERT INTO users (username, password_hash, display_name, created_by)
            VALUES (${body.username}, ${passwordHash}, ${body.displayName}, ${user?.username ?? null})
          `;
          return { success: true, message: 'User created' };
        },
        {
          body: t.Object({
            username: t.String({ minLength: 1 }),
            password: t.String({ minLength: 3 }),
            displayName: t.String({ minLength: 1 }),
          }),
        },
      ),
  );
