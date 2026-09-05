// Suppress noisy Bun ws.WebSocket warnings (Baileys uses ws features not yet in Bun)
// @ts-ignore
const _origEmitWarning = process.emitWarning.bind(
  process,
) as typeof process.emitWarning;
// @ts-ignore
(
  process as unknown as { emitWarning: typeof process.emitWarning }
).emitWarning = (
  warning: string | Error,
  ...args: Parameters<typeof process.emitWarning>
) => {
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (msg.includes('ws.WebSocket')) return;
  return (_origEmitWarning as (...a: unknown[]) => void)(warning, ...args);
};
// @ts-ignore
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (String(args[0] ?? '').includes('ws.WebSocket')) return;
  return (_origWarn as (...a: unknown[]) => void)(...args);
};

import './shutdown';

import { hashPassword } from './auth/password';
import { DEFAULT_USERS } from './config';
import { dbReady, sql } from './db/client';
import { migrate } from './db/migrate';
import { logger } from './logger';
import { SessionHolder } from './whatsapp';

await migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});

const ready = await dbReady();
if (!ready) {
  logger.error('Cannot connect to Postgres. Exiting.');
  process.exit(1);
}

// Auto-seed default users if users table is empty and DEFAULT_USERS env var is set
// Passwords are NEVER hardcoded in source — always read from environment
if (DEFAULT_USERS) {
  const count = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM users
  `;
  if (Number(count[0]?.c ?? 0) === 0) {
    try {
      const users = JSON.parse(DEFAULT_USERS) as {
        username: string;
        password: string;
        displayName: string;
      }[];
      for (const u of users) {
        if (!u.username || !u.password) continue;
        const hash = await hashPassword(u.password);
        await sql`
          INSERT INTO users (username, password_hash, display_name, role, protected)
          VALUES (${u.username}, ${hash}, ${u.displayName || u.username}, 'admin', true)
          ON CONFLICT (username) DO NOTHING
        `;
        logger.info(`Auto-seeded user: ${u.username} (admin, protected)`);
      }
    } catch (e) {
      logger.error({ e }, 'Failed to parse DEFAULT_USERS env var');
    }
  }
}

const holder = SessionHolder.getInstance();

logger.info('🚀 wagss v0.1.0 started');
await holder.autoStartOnBoot();

// Periodic log retention (7 days)
(
  globalThis as unknown as { __wagssCleanupInterval?: NodeJS.Timeout }
).__wagssCleanupInterval = setInterval(
  () => sql`SELECT cleanup_logs()`.catch(() => {}),
  24 * 60 * 60 * 1000,
);
sql`SELECT cleanup_logs()`.catch(() => {});

import('./server').catch((err) => {
  logger.error(
    {
      message: err instanceof Error ? err.message : String(err),
    },
    'Failed to start server',
  );
  process.exit(1);
});
