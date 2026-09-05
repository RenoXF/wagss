import { dbReady, sql } from '@/db/client';
import { logger } from '@/logger';
import { WhatsAppSession } from './whatsapp-session';

/**
 * Single-account session holder. Owns the one WhatsApp session;
 * auto-reconnects on startup if the account is already registered
 * (creds present in Postgres auth_state).
 */
export class SessionHolder {
  private static instance: SessionHolder;
  private session: WhatsAppSession | null = null;
  private starting: Promise<WhatsAppSession> | null = null;

  private constructor() {}

  static getInstance(): SessionHolder {
    if (!SessionHolder.instance) {
      SessionHolder.instance = new SessionHolder();
    }
    return SessionHolder.instance;
  }

  get(): WhatsAppSession | null {
    return this.session;
  }

  getActive(): WhatsAppSession | null {
    if (!this.session) return null;
    if (this.session.getIsConnecting() || this.session.getIsLoggedIn()) {
      return this.session;
    }
    return null;
  }

  getOrCreate(phoneNumber: string | null = null): WhatsAppSession {
    if (!this.session) {
      this.session = new WhatsAppSession(phoneNumber);
      this.attachAutoRecreate(this.session);
    } else if (phoneNumber && this.session.phoneNumber !== phoneNumber) {
      // Update phoneNumber if caller provides a new one and not yet registered
      const s = this.session.getStatus();
      if (!s.isLoggedIn) {
        this.session.phoneNumber = phoneNumber as never;
      }
    }
    return this.session;
  }

  private attachAutoRecreate(session: WhatsAppSession) {
    session.on('session-stopped', (reason) => {
      // Auto-recreate for transient disconnects, not for explicit logout/forbidden
      if (
        reason === 'loggedOut' ||
        reason === 'forbidden' ||
        reason === 'disconnectedByUser'
      )
        return;
      if (reason === 'qrTimeout') return;
      logger.info(
        { reason },
        '[SessionHolder] Session stopped, will auto-recreate on next start',
      );
    });
  }

  async start(phoneNumber: string | null = null): Promise<WhatsAppSession> {
    if (this.starting) return this.starting;
    const session = this.getOrCreate(phoneNumber);
    this.starting = session
      .connect(phoneNumber)
      .then(() => session)
      .catch((err) => {
        logger.error({ err }, '[SessionHolder] Failed to start session');
        throw err;
      })
      .finally(() => {
        this.starting = null;
      });
    // Fire-and-forget for caller that expects immediate return, but also return the promise for awaiters
    this.starting.catch(() => {});
    return session;
  }

  async stop(): Promise<boolean> {
    if (!this.session) return false;
    try {
      await this.session.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  async logout(): Promise<boolean> {
    if (!this.session) return false;
    try {
      await this.session.logout();
      this.session = null;
      return true;
    } catch {
      return false;
    }
  }

  async autoStartOnBoot(): Promise<void> {
    try {
      if (!(await dbReady())) return;

      const rows = await sql<{ c: string }[]>`
        SELECT count(*)::text AS c FROM auth_state WHERE key = 'creds'
      `;
      if (Number(rows[0]?.c) === 0) return;

      logger.info(
        '[SessionHolder] Registered account found, auto-connecting...',
      );
      await this.start();
    } catch (err) {
      logger.error({ err }, '[SessionHolder] autoStartOnBoot failed');
    }
  }
}
