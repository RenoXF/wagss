import { authUser } from '@/auth/middleware';
import { HOSTNAME, PORT } from '@/config';
import { logger } from '@/logger';
import { SessionHolder } from '@/whatsapp';
import { cors } from '@elysiajs/cors';
import { file } from 'bun';
import { Elysia } from 'elysia';
import { cpus, freemem, hostname, uptime as osUptime, totalmem } from 'node:os';
import { version } from 'package.json';
import icon from '../../assets/icon.ico' with { type: 'file' };
import { authRoutes } from './auth';
import indexClient from './client/index.html' with { type: 'text' };
import { contactRoutes } from './contacts';
import { groupRoutes } from './groups';
import { mediaRoutes } from './media';
import { messageRoutes } from './messages';
import { presenceRoutes } from './presence';
import { sessionRoutes } from './session';
import { sseRoutes } from './sse';
import { usersRoutes } from './users';

const startTime = Date.now();

const app = new Elysia()
  .use(
    cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  )
  .use(authUser)
  .use(authRoutes)
  .use(usersRoutes)
  .use(sessionRoutes)
  .use(messageRoutes)
  .use(contactRoutes)
  .use(groupRoutes)
  .use(mediaRoutes)
  .use(presenceRoutes)
  .use(sseRoutes)
  .get(
    '/',
    ({ set }) => {
      set.headers['content-type'] = 'text/html';
      return indexClient;
    },
    { detail: { hide: true } },
  )
  .get(
    '/icon.ico',
    ({ set }) => {
      set.headers['content-type'] = 'image/x-icon';
      return file(icon);
    },
    { detail: { hide: true } },
  )
  .get(
    '/system/info',
    () => {
      const mem = process.memoryUsage();
      const holder = SessionHolder.getInstance();
      const session = holder.get();
      return {
        success: true,
        data: {
          app: {
            name: 'WAGSS',
            version,
            description: 'Single-Account WhatsApp Gateway',
            uptime: Math.floor((Date.now() - startTime) / 1000),
          },
          runtime: {
            bun: Bun.version,
            arch: process.arch,
            platform: process.platform,
            pid: process.pid,
          },
          system: {
            hostname: hostname(),
            cpus: cpus().length,
            memory: {
              total: totalmem(),
              free: freemem(),
              used: totalmem() - freemem(),
              process: mem.rss,
              heap: mem.heapUsed,
            },
            os_uptime: Math.floor(osUptime()),
          },
          session: session?.getStatus() ?? null,
        },
      };
    },
    {
      detail: {
        summary: 'System Info',
        description: 'Get detailed system information about the WAGSS server.',
      },
    },
  )
  .listen(
    { port: PORT, hostname: HOSTNAME, reusePort: false },
    ({ hostname, port }) => {
      logger.info(`🐘 wagss API is running at ${hostname}:${port}`);
    },
  );

export { app };
