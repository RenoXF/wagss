import { sql } from './db/client';
import { logger } from './logger';
import { SessionHolder } from './whatsapp';

let shuttingDown = false;

const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}. Shutting down...`);

  const holder = SessionHolder.getInstance();
  try {
    await Promise.race([
      holder.stop().catch(() => {}),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stop timeout')), 5000),
      ),
    ]);
  } catch {}

  // Clear periodic intervals if exposed
  try {
    const iv = (
      globalThis as unknown as { __wagssCleanupInterval?: NodeJS.Timeout }
    ).__wagssCleanupInterval;
    if (iv) clearInterval(iv);
  } catch {}

  try {
    await sql.end({ timeout: 5 });
    logger.info('Database connection closed. Exiting now.');
  } catch (err) {
    logger.error({ err }, 'Error closing database connection');
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGQUIT', shutdown);
process.on('unhandledRejection', (reason) => {
  logger.error(reason instanceof Error ? reason.message : String(reason));
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}, caused by: ${err.stack}`);
  // For 24/7, exit so process manager can restart with clean state
  setTimeout(() => process.exit(1), 1000);
});
