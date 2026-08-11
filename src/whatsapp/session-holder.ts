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

  private constructor() {}

  static getInstance(): SessionHolder {
    if (!SessionHolder.instance) {
      SessionHolder.instance = new SessionHolder();
    }
    return SessionHolder.instance;
  }

  get(): WhatsAppSession | null {
    if (
      this.session &&
      (this.session.getIsConnecting() || this.session.getIsLoggedIn())
    ) {
      return this.session;
    }
    return this.session;
  }

  getOrCreate(phoneNumber: string | null = null): WhatsAppSession {
    if (!this.session) {
      this.session = new WhatsAppSession(phoneNumber);
    }
    return this.session;
  }

  async start(phoneNumber: string | null = null): Promise<WhatsAppSession> {
    const session = this.getOrCreate(phoneNumber);
    session.connect(phoneNumber).catch((err) => {
      logger.error({ err }, '[SessionHolder] Failed to start session');
    });
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
    if (!(await dbReady())) return;

    const rows = await sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM auth_state WHERE key = 'creds'
    `;
    if (Number(rows[0]?.c) === 0) return;

    logger.info('[SessionHolder] Registered account found, auto-connecting...');
    await this.start();
  }
}
