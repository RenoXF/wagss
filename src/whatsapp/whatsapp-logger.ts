import path from 'node:path';
import P from 'pino';
import { createStream } from 'rotating-file-stream';

/**
 * Create a logger instance for WhatsApp session with daily rotation
 * @param sessionId Session identifier
 * @returns Pino logger instance configured with rotating file stream
 */
export function createWhatsAppLogger(sessionId: string): P.Logger {
  const logDir = path.join(process.cwd(), 'logs', sessionId);

  // Create rotating stream that rotates daily
  const stream = createStream(`${sessionId}.log`, {
    interval: '1d', // Rotate daily
    path: logDir,
    compress: 'gzip', // Compress rotated files
    maxFiles: 30, // Keep 30 days of logs
  });

  const logger = P(
    {
      level: 'info',
      base: { sessionId },
    },
    stream,
  ) as P.Logger & { warn: P.Logger['warn'] };
  // Downgrade noisy Baileys warning to debug (spam on every open)
  const origWarn = logger.warn.bind(logger);
  (logger as unknown as { warn: (...args: unknown[]) => void }).warn = (
    ...args: unknown[]
  ) => {
    const msg =
      typeof args[0] === 'string'
        ? args[0]
        : typeof args[1] === 'string'
          ? args[1]
          : '';
    if (msg.includes('no name present, ignoring presence update')) return;
    return (origWarn as (...a: unknown[]) => void)(...args);
  };
  return logger;
}
