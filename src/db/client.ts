import { getDbConnection } from '@/config';
import { logger } from '@/logger';
import postgres from 'postgres';

export const sql = postgres(
  getDbConnection() as Parameters<typeof postgres>[0],
  {
    max: Bun.env.DB_POOLED === 'true' ? 10 : 1,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    onclose: () => {},
  },
);

export async function dbReady(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, '[DB] Cannot reach Postgres');
    return false;
  }
}
