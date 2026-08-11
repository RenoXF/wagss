import { QR_TIMEOUT_MS } from '@/config';
import { sql } from '@/db/client';
import { Boom } from '@hapi/boom';
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBot,
  isJidBroadcast,
  isJidMetaAI,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  makeWASocket,
  proto,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WAConnectionState,
  type WASocket,
} from 'baileys';
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import PQueue from 'p-queue';
import P from 'pino';
import {
  addContactLabel,
  removeContactLabel,
  upsertContact,
  upsertContactMinimal,
} from './contact-store';
import { saveGroupSafe } from './group-store';
import { downloadMedia } from './media-store';
import {
  extractText,
  markMessageDeleted,
  updateMessageEdited,
  upsertMessage,
} from './message-store';
import { initPostgresAuthState } from './postgres-auth-state';
import { saveReaction } from './reaction-store';
import { saveStatus } from './status-store';
import { validatePhoneNumber } from './validate-phone-number';
import { createWhatsAppLogger } from './whatsapp-logger';

interface WhatsAppSessionEvents {
  qr: [string];
  'pairing-code': [string];
  authenticated: [WASocket];
  'connection-close': [number | undefined];
  'session-stopped': [string];
  error: [Error];
}

const SESSION_ID = 'wagss';

export class WhatsAppSession extends EventEmitter<WhatsAppSessionEvents> {
  private static sseClients = new Set<() => void>();
  private static sseListeners = new Set<(data: string) => void>();

  /** Broadcast an event to all connected /sse/live clients. */
  static emitToSse(data: string): void {
    for (const cb of WhatsAppSession.sseListeners) {
      try {
        cb(data);
      } catch {}
    }
  }

  static subscribeSse(callback: (data: string) => void): () => void {
    WhatsAppSession.sseListeners.add(callback);
    return () => WhatsAppSession.sseListeners.delete(callback);
  }

  public phoneNumber: string | null;

  private logger: P.Logger;
  private DEFAULT_TIMEOUT = 0;

  private socket: WASocket | null = null;
  private isLoggedIn: boolean = false;
  private qrCode: string | null = null;
  private pairingCode: string | null = null;
  private timeout: NodeJS.Timeout | undefined = undefined;
  private qrTimeout: NodeJS.Timeout | undefined = undefined;
  private heartbeatInterval: NodeJS.Timeout | undefined = undefined;

  private messageQueue = new PQueue({ concurrency: 1 });
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 5_000;

  private _connectionState: WAConnectionState = 'close';
  private _isNewSession: boolean = false;

  /** FIFO of user-attribution pending for outgoing messages. */
  private pendingSend: Array<{
    jid: string;
    sentBy: string;
    senderName: string;
  }> = [];

  constructor(phoneNumber: string | null = null) {
    super();
    this.phoneNumber = phoneNumber ? validatePhoneNumber(phoneNumber) : null;
    this.logger = createWhatsAppLogger(SESSION_ID);
  }

  get id(): string {
    return SESSION_ID;
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  getIsLoggedIn(): boolean {
    return this.isLoggedIn || this._connectionState === 'open';
  }

  getIsConnecting(): boolean {
    return this._connectionState === 'connecting';
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  getPairingCode(): string | null {
    return this.pairingCode;
  }

  getConnectionState(): WAConnectionState {
    return this._connectionState;
  }

  getStatus() {
    return {
      user: this.socket?.user || null,
      connectionState: this._connectionState,
      phoneNumber: this.phoneNumber,
      isLoggedIn: this.isLoggedIn,
      hasQrCode: this.qrCode !== null,
      hasPairingCode: this.pairingCode !== null,
    };
  }

  async connect(phoneNumber: string | null = null): Promise<WASocket> {
    if (this.socket) {
      this.logger.info('Socket already connected. Reusing existing connection');
      return this.socket;
    }

    if (phoneNumber) {
      this.phoneNumber = validatePhoneNumber(phoneNumber) ?? null;
    }

    return new Promise<WASocket>(async (resolve, reject) => {
      try {
        const { state, saveCreds, clearCreds } =
          await initPostgresAuthState(sql);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
          version: version,
          logger: this.logger,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, this.logger),
          },
          browser: ['Windows', 'Edge', '120.0.0'],
          generateHighQualityLinkPreview: true,
          markOnlineOnConnect: true,
          syncFullHistory: true,
          shouldIgnoreJid: (jid) =>
            isJidBot(jid) ||
            isJidBroadcast(jid) ||
            isJidMetaAI(jid) ||
            isJidStatusBroadcast(jid),
          getMessage: async (key) => {
            if (!key?.id || !key?.remoteJid) return undefined;
            const { getMessage } = await import('./message-store');
            const row = await getMessage(`${key.remoteJid}-${key.id}`);
            const full = row?.message as
              { message?: proto.IMessage } | undefined;
            if (full?.message) return full.message;
            return undefined;
          },
        });

        this.socket = sock;
        this.isLoggedIn = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (upsert) => {
          for (const msg of upsert.messages) {
            if (!msg.key?.id || !msg.key?.remoteJid) continue;

            // protocolMessage: edit / delete-for-everyone
            const pm = msg.message?.protocolMessage;
            if (pm) {
              const targetJid = pm.key?.remoteJid ?? msg.key.remoteJid;
              const targetId = pm.key?.id;
              if (targetJid && targetId) {
                if (pm.type === 0) {
                  // REVOKE -> delete for everyone
                  await markMessageDeleted(targetJid, targetId).catch(() => {});
                  WhatsAppSession.emitToSse(
                    JSON.stringify({
                      type: 'message_deleted',
                      data: { chatJid: targetJid, messageId: targetId },
                    }),
                  );
                } else if (pm.type === 14 && pm.editedMessage) {
                  // MESSAGE_EDIT -> update stored message
                  const edited = {
                    ...msg,
                    key: { ...msg.key, id: targetId, remoteJid: targetJid },
                    message: pm.editedMessage,
                  };
                  await updateMessageEdited(targetJid, targetId, edited).catch(
                    () => {},
                  );
                  WhatsAppSession.emitToSse(
                    JSON.stringify({
                      type: 'message_edited',
                      data: {
                        chatJid: targetJid,
                        messageId: targetId,
                        text: extractText(edited),
                      },
                    }),
                  );
                }
              }
              continue;
            }

            let sentByUser: string | undefined;
            let senderName: string | null = null;

            if (msg.key.fromMe) {
              const idx = this.pendingSend.findIndex(
                (p) => p.jid === msg.key.remoteJid,
              );
              if (idx >= 0) {
                const pending = this.pendingSend.splice(idx, 1)[0];
                if (pending) {
                  sentByUser = pending.sentBy;
                  senderName = pending.senderName;
                }
              }
              await upsertMessage(msg, {
                sentByUser,
                senderName,
              });
            } else {
              senderName = await this.getContactName(msg.key.remoteJid);
              await upsertMessage(msg, { senderName });
            }

            // Auto-download stickers (small, always wanted). Other media is
            // downloaded on demand via GET /media?download=1.
            const mtype = Object.keys(msg.message ?? {})[0];
            if (mtype === 'stickerMessage' && this.socket) {
              downloadMedia(msg, this.socket as never).catch(() => {});
            }

            WhatsAppSession.emitToSse(
              JSON.stringify({
                type: 'message',
                data: {
                  chatJid: msg.key.remoteJid,
                  message: msg,
                  sentByUser,
                },
              }),
            );
          }
          WhatsAppSession.emitToSse(
            JSON.stringify({ type: 'chats', data: null }),
          );
        });

        sock.ev.on('contacts.update', (contacts) => {
          for (const c of contacts) {
            if (c.id) {
              upsertContact(
                c as {
                  id: string;
                  name?: string;
                  notify?: string;
                  imgUrl?: string;
                  status?: string;
                  lid?: string;
                },
              ).catch(() => {});
            }
          }
        });

        sock.ev.on('contacts.upsert', (contacts) => {
          for (const c of contacts) {
            if (c.id) {
              upsertContact(
                c as {
                  id: string;
                  name?: string;
                  notify?: string;
                  imgUrl?: string;
                  status?: string;
                  lid?: string;
                },
              ).catch(() => {});
              WhatsAppSession.emitToSse(
                JSON.stringify({ type: 'contact', data: { jid: c.id } }),
              );
            }
          }
        });

        sock.ev.on('presence.update', (update) => {
          const presences = update.presences || {};
          for (const [jid, presence] of Object.entries(presences)) {
            WhatsAppSession.emitToSse(
              JSON.stringify({
                type: 'presence',
                data: { jid, presence: presence.lastKnownPresence },
              }),
            );
          }
        });

        // Label definitions + per-contact label associations.
        const labelNames = new Map<string, string>();
        sock.ev.on('labels.edit', (label) => {
          if (label?.id && label?.name) {
            labelNames.set(String(label.id), label.name);
          }
        });
        sock.ev.on('labels.association', (evt) => {
          const assoc = evt?.association as
            { chatId?: string; labelId?: string } | undefined;
          const jid = assoc?.chatId;
          const labelId = assoc?.labelId;
          if (!jid || !labelId) return;
          if (evt?.type === 'remove') {
            removeContactLabel(jid, String(labelId)).catch(() => {});
          } else {
            const name = labelNames.get(String(labelId)) ?? String(labelId);
            addContactLabel(jid, String(labelId), name).catch(() => {});
          }
        });

        sock.ev.on('messages.update', (updates) => {
          for (const u of updates) {
            const status = u.update.status;
            if (status && u.key?.remoteJid) {
              const label =
                status === 2 ? 'read' : status === 1 ? 'delivered' : 'sent';
              saveStatus(u as never).catch(() => {});
              WhatsAppSession.emitToSse(
                JSON.stringify({
                  type: 'message_status',
                  data: {
                    jid: u.key.remoteJid,
                    id: u.key.id,
                    status: label,
                    toJid: u.key.participant ?? null,
                  },
                }),
              );
            }
          }
        });

        sock.ev.on('message-receipt.update', (updates) => {
          for (const u of updates) {
            const receipt = u.receipt as unknown as {
              type?: string;
              userJid?: string | null;
            };
            saveStatus(u as never).catch(() => {});
            const status =
              receipt?.type === 'read'
                ? 'read'
                : receipt?.type === 'delivery'
                  ? 'delivered'
                  : (receipt?.type ?? 'sent');
            WhatsAppSession.emitToSse(
              JSON.stringify({
                type: 'message_status',
                data: {
                  jid: u.key?.remoteJid,
                  id: u.key?.id,
                  status,
                  toJid: receipt?.userJid ?? null,
                },
              }),
            );
          }
        });

        sock.ev.on('messages.reaction', (reactions) => {
          for (const r of reactions) {
            saveReaction(r as never).catch(() => {});
            WhatsAppSession.emitToSse(
              JSON.stringify({
                type: 'reaction',
                data: {
                  chatJid: r.key?.remoteJid,
                  messageId: r.key?.id,
                  fromJid: r.key?.participant ?? r.key?.remoteJid,
                  reaction: r.reaction?.text ?? null,
                },
              }),
            );
          }
        });

        const saveGroupFromSocket = (id: string) => {
          sock
            .groupMetadata(id)
            .then((meta) => saveGroupSafe(meta))
            .catch(() => {});
        };

        sock.ev.on('groups.upsert', (groups) => {
          for (const g of groups) {
            saveGroupSafe(g);
            WhatsAppSession.emitToSse(
              JSON.stringify({ type: 'group', data: { id: g.id } }),
            );
          }
        });

        sock.ev.on('groups.update', (updates) => {
          for (const g of updates) {
            if (!g.id) continue;
            saveGroupFromSocket(g.id);
          }
        });

        sock.ev.on('group-participants.update', (update) => {
          if (!update.id) return;
          saveGroupFromSocket(update.id);
        });

        sock.ev.on('messaging-history.set', ({ messages, contacts, chats }) => {
          Promise.all([
            messages
              .filter((m) => m.key?.remoteJid && m.key?.id)
              .map(async (m) => upsertMessage(m)),
            contacts.map((c) =>
              upsertContact(
                c as {
                  id: string;
                  name?: string;
                  notify?: string;
                  imgUrl?: string;
                  status?: string;
                  lid?: string;
                },
              ),
            ),
          ])
            .catch(() => {})
            .finally(() => {
              WhatsAppSession.emitToSse(
                JSON.stringify({ type: 'history_done', data: null }),
              );
            });
          void chats;
        });

        sock.ev.on('connection.update', async (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            this.qrCode = qr;
            this.emit('qr', qr);

            // Anti-spam guard: if the account isn't paired yet, kill the
            // process after QR_TIMEOUT_MS so Baileys doesn't keep
            // regenerating QR codes 24/7 while waiting for a scan.
            if (!sock.authState.creds.registered) {
              clearTimeout(this.qrTimeout);
              this.qrTimeout = setTimeout(() => {
                this.logger.warn(
                  `QR link not scanned within ${QR_TIMEOUT_MS / 1000}s, stopping process`,
                );
                // End the WS with a code the close handler treats as a
                // permanent stop (no auto-reconnect, no QR loop).
                sock.end(new Boom('QR link expired', { statusCode: 1001 }));
              }, QR_TIMEOUT_MS);
            }

            if (!sock.authState.creds.registered && this.phoneNumber) {
              try {
                const code = await sock.requestPairingCode(this.phoneNumber);
                this.logger.info({ code }, 'Pairing code generated');
                this.pairingCode = code;
                this.emit('pairing-code', code);
              } catch (error) {
                this.logger.error({ error }, 'Failed to request pairing code');
                this.emit(
                  'error',
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            }
            this.broadcastState();
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output
              ?.statusCode;
            this.emit('connection-close', statusCode);

            switch (statusCode) {
              case DisconnectReason.unavailableService:
              case DisconnectReason.connectionClosed:
              case DisconnectReason.connectionLost:
                if (
                  statusCode === DisconnectReason.connectionClosed &&
                  (!this.isLoggedIn || this.pairingCode)
                ) {
                  clearCreds();
                }
                if (
                  statusCode === DisconnectReason.connectionLost &&
                  this.pairingCode
                ) {
                  clearCreds();
                }
                this.cleanup();
                this.connect().catch((err) => this.emit('error', err));
                break;

              case DisconnectReason.forbidden:
                await this.disconnect();
                clearCreds();
                this.emit('session-stopped', 'forbidden');
                break;

              case DisconnectReason.badSession:
              case DisconnectReason.multideviceMismatch:
              case DisconnectReason.connectionReplaced:
                this.cleanup(true);
                clearCreds();
                this.emit(
                  'session-stopped',
                  statusCode === DisconnectReason.badSession
                    ? 'badSession'
                    : statusCode === DisconnectReason.multideviceMismatch
                      ? 'multideviceMismatch'
                      : 'connectionReplaced',
                );
                break;

              case DisconnectReason.loggedOut:
                this.qrCode = null;
                this.pairingCode = null;
                this.isLoggedIn = false;
                this.socket = null;
                clearCreds();
                this.destroy();
                this.emit('session-stopped', 'loggedOut');
                break;

              case DisconnectReason.restartRequired:
                this.cleanup();
                this._isNewSession = true;
                clearTimeout(this.timeout);
                this.connect().catch((err) => this.emit('error', err));
                break;

              case 998:
                this.cleanup(true);
                this.emit('session-stopped', 'disconnectedByUser');
                break;

              case 999:
                if (this.pairingCode && !this.isLoggedIn) {
                  clearCreds();
                }
                this.cleanup(true);
                break;

              // QR link timeout / permanent manual stop: do NOT reconnect
              case 1001:
                clearTimeout(this.qrTimeout);
                this.qrTimeout = undefined;
                this.cleanup(true);
                clearCreds();
                this.emit('session-stopped', 'qrTimeout');
                break;

              default:
                if (statusCode === 500) {
                  this.cleanup();
                  this.connect().catch((err) => this.emit('error', err));
                }
            }
          } else if (connection === 'open') {
            clearTimeout(this.timeout);
            this.timeout = undefined;
            clearTimeout(this.qrTimeout);
            this.qrTimeout = undefined;
            this.isLoggedIn = true;
            this.socket = sock;
            this.qrCode = null;
            this.pairingCode = null;
            this.emit('authenticated', sock);

            if (this._isNewSession) {
              sock.groupFetchAllParticipating().catch(() => {});
            }

            this.heartbeatInterval = setInterval(
              () => {
                this.broadcastState();
              },
              1000 * 60 * 30,
            );

            this.broadcastState();
            return resolve(sock);
          } else if (connection === 'connecting') {
            this.qrCode = null;
            this.pairingCode = null;
            this.broadcastState();
          }

          if (connection) {
            this._connectionState = connection;
            this.broadcastState();
          }
        });

        if (this.DEFAULT_TIMEOUT > 0) {
          this.timeout = setTimeout(
            () => {
              if (this.socket) {
                this.socket.end(
                  new Boom('Process timeout reached', { statusCode: 999 }),
                );
                this.socket = null;
              }
              this.isLoggedIn = false;
            },
            1000 * 60 * this.DEFAULT_TIMEOUT,
          );
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit('error', err);
        reject(err);
      }
    });
  }

  private async getContactName(jid: string): Promise<string | null> {
    const rows = await sql<{ name: string | null }[]>`
      SELECT name FROM contacts WHERE jid = ${jid} LIMIT 1
    `;
    return rows[0]?.name ?? null;
  }

  private broadcastState(): void {
    WhatsAppSession.emitToSse(
      JSON.stringify({
        type: 'device_state',
        data: {
          status: this._connectionState,
          isLoggedIn: this.isLoggedIn,
          qrCode: this.qrCode,
          pairingCode: this.pairingCode,
          phoneNumber: this.phoneNumber,
        },
      }),
    );
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.timeout);
    if (this.socket) {
      this.socket.end(
        new Boom('Session disconnected by user', { statusCode: 998 }),
      );
      this.socket = null;
    }
    this.cleanup(true);
  }

  async logout(): Promise<void> {
    if (this.socket) {
      await this.socket
        .logout('User logged out')
        .catch((err) => this.logger.error({ err }, 'Error during logout'));
      this.socket = null;
    }
    this.cleanup(true);
  }

  async destroy(): Promise<void> {
    await this.disconnect();
  }

  private cleanup(fullCleanup: boolean = false): void {
    this.socket = null;
    this.isLoggedIn = false;
    this.qrCode = null;
    this.pairingCode = null;
    clearTimeout(this.qrTimeout);
    this.qrTimeout = undefined;
    this.messageQueue.clear();
    this._connectionState = 'close';
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = undefined;
    this._isNewSession = false;
    void fullCleanup;
  }

  /**
   * Send a message. Resolves when the queued send completes (success or
   * exhausted retries). Attribution (sentByUser/senderName) is recorded so
   * the Baileys echo is persisted with the correct user.
   */
  async sendMessage(
    jid: string,
    content: AnyMessageContent,
    options: MiscMessageGenerationOptions | undefined = undefined,
    sendPresence: boolean = false,
    delay: number = 60,
    attribution?: { sentBy: string; senderName: string },
  ): Promise<void> {
    if (attribution) {
      this.pendingSend.push({
        jid,
        sentBy: attribution.sentBy,
        senderName: attribution.senderName,
      });
    }

    const send = async () => {
      if (!this.socket) {
        throw new Error('WhatsApp not connected');
      }

      if (sendPresence) {
        await this.socket
          .presenceSubscribe(jid)
          .catch((r) => this.logger.error({ error: r }, 'subscribe error'));
        await Bun.sleep(randomInt(10, 15) * 100);
        await this.socket
          .sendPresenceUpdate('available', jid)
          .catch((r) => this.logger.error({ error: r }, 'presence error'));
        await Bun.sleep(randomInt(10, 15) * 100);
        await this.socket
          .sendPresenceUpdate('composing', jid)
          .catch((r) => this.logger.error({ error: r }, 'composing error'));
        await Bun.sleep(randomInt(2, 5) * 1000);
        await this.socket
          .sendPresenceUpdate('paused', jid)
          .catch((r) => this.logger.error({ error: r }, 'paused error'));
        await Bun.sleep(randomInt(10, 15) * 100);
      } else {
        const jitter = (base: number) =>
          Math.max(0, Math.round(base * 1000 + (Math.random() - 0.5) * 30000));
        await Bun.sleep(jitter(delay));
      }

      await this.socket.sendMessage(jid, content, options ?? undefined);
      await Bun.sleep(
        Math.max(0, Math.round(delay * 1000 + (Math.random() - 0.5) * 30000)),
      );
    };

    const sendWithRetry = async () => {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
        try {
          await send();
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < this.MAX_RETRIES) {
            await Bun.sleep(this.RETRY_DELAY);
          }
        }
      }
      throw lastError;
    };

    const MAX_QUEUED = Number(Bun.env.SEND_QUEUE_MAX ?? 500);
    if (this.messageQueue.size >= MAX_QUEUED) {
      throw new Error(`Send queue full (${MAX_QUEUED}), try again later`);
    }

    await this.messageQueue.add(sendWithRetry);
  }
}
