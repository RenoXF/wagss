function resolveJwtSecret(): string {
  const secret = Bun.env.JWT_SECRET;
  if (secret) return secret;
  if (Bun.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET environment variable is required in production',
    );
  }
  console.warn(
    '⚠️  JWT_SECRET not set — using random ephemeral secret (sessions will not survive restart). Set JWT_SECRET in .env for persistent sessions.',
  );
  return crypto.randomUUID();
}
export const JWT_SECRET = resolveJwtSecret();
export const PORT = Bun.env.PORT ? Number(Bun.env.PORT) : 3000;
export const HOSTNAME = Bun.env.HOSTNAME ?? '127.0.0.1';
export const QR_TIMEOUT_MS = (Number(Bun.env.QR_TIMEOUT_SECONDS) || 300) * 1000;
export const MEDIA_PATH = Bun.env.MEDIA_PATH || 'data/media';
export const AUTO_DOWNLOAD_ALL = Bun.env.AUTO_DOWNLOAD_ALL === 'true';
export const AUTO_DOWNLOAD_STICKER = Bun.env.AUTO_DOWNLOAD_STICKER !== 'false';
export const DEFAULT_USERNAME = Bun.env.DEFAULT_USERNAME || 'root';
export const DEFAULT_PASSWORD = Bun.env.DEFAULT_PASSWORD || '';
export const DEFAULT_DISPLAY_NAME = Bun.env.DEFAULT_DISPLAY_NAME || 'root';
export const MAX_RECONNECT_DELAY_MS = Bun.env.RECONNECT_MAX_MS
  ? Number(Bun.env.RECONNECT_MAX_MS)
  : 30_000;

/**
 * Postgres connection target, Laravel-style env vars:
 * DB_CONNECTION, DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD,
 * DB_POOLED. Falls back to local unix-socket peer auth if DB_DATABASE is
 * unset (default local install pattern: `createdb wagss`).
 */
export function getDbConnection():
  string | { host: string; database: string; username: string } {
  const database = Bun.env.DB_DATABASE;
  if (database) {
    const host = Bun.env.DB_HOST ?? '127.0.0.1';
    const port = Bun.env.DB_PORT ?? '5432';
    const username = Bun.env.DB_USERNAME ?? 'postgres';
    const password = Bun.env.DB_PASSWORD ?? '';
    const url = new URL(
      `postgres://${encodeURIComponent(username)}@${host}:${port}/${encodeURIComponent(database)}`,
    );
    if (password) url.password = password;
    return url.toString();
  }
  return {
    host: '/var/run/postgresql',
    database: 'wagss',
    username: 'postgres',
  };
}
