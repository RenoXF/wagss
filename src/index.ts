import { hashPassword } from './auth/password';
import {
  DEFAULT_DISPLAY_NAME,
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
} from './config';
import { dbReady, sql } from './db/client';
import { migrate } from './db/migrate';
import { logger } from './logger';
import { SessionHolder } from './whatsapp';

await migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});

// Auto-seed default user if users table is empty
const count = await sql<{ c: number }[]>`
  SELECT count(*)::int AS c FROM users
`;
if (Number(count[0]?.c ?? 0) === 0 && DEFAULT_USERNAME && DEFAULT_PASSWORD) {
  const hash = await hashPassword(DEFAULT_PASSWORD);
  await sql`
    INSERT INTO users (username, password_hash, display_name)
    VALUES (${DEFAULT_USERNAME}, ${hash}, ${DEFAULT_DISPLAY_NAME ?? DEFAULT_USERNAME})
  `;
  logger.info(`Auto-seeded default user: ${DEFAULT_USERNAME}`);
}

const ready = await dbReady();
if (!ready) {
  logger.error('Cannot connect to Postgres. Exiting.');
  process.exit(1);
}

import './shutdown';

const holder = SessionHolder.getInstance();

logger.info('🚀 wagss v0.1.0 started');
await holder.autoStartOnBoot();

import('./server').catch((err) => {
  logger.error(
    {
      message: err instanceof Error ? err.message : String(err),
    },
    'Failed to start server',
  );
  process.exit(1);
});
