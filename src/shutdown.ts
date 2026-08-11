import { sql } from './db/client';
import { logger } from './logger';
import { SessionHolder } from './whatsapp';

const shutdown = async (signal: NodeJS.Signals) => {
  logger.info(`Received ${signal}. Shutting down...`);

  const holder = SessionHolder.getInstance();
  await holder.stop().catch(() => {});

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
});
