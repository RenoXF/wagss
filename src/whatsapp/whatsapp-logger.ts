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

  return P(
    {
      level: 'info',
      base: { sessionId },
    },
    stream,
  );
}
