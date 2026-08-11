import P from 'pino';

export const logger = P({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    Bun.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});
