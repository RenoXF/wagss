import { Elysia } from 'elysia';
import { SignJWT, jwtVerify } from 'jose';
import { JWT_COOKIE, JWT_SECRET } from './jwt';

export interface JwtUser {
  userId: number;
  username: string;
  displayName: string;
}

const key = new TextEncoder().encode(JWT_SECRET);

export async function signToken(user: JwtUser): Promise<string> {
  return new SignJWT({
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(key);
}

export async function verifyToken(token: string): Promise<JwtUser | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    if (
      typeof payload.userId === 'number' &&
      typeof payload.username === 'string'
    ) {
      return {
        userId: payload.userId,
        username: payload.username,
        displayName:
          (typeof payload.displayName === 'string'
            ? payload.displayName
            : null) ?? payload.username,
      };
    }
  } catch {}
  return null;
}

export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function cookieHeader(
  name: string,
  value: string,
  maxAge = 60 * 60 * 24 * 7,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (Bun.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

/**
 * Global plugin: adds `user` (JwtUser | null) to context, derived from the
 * JWT cookie. `as('global')` makes the derived type reach handlers that
 * `.use()` this plugin.
 */
export const authUser = new Elysia({ name: 'auth' })
  .derive(async ({ request }) => {
    const token = readCookie(request.headers, JWT_COOKIE);
    const user = token ? await verifyToken(token) : null;
    return { user };
  })
  .as('global');
