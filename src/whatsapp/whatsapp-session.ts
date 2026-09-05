import {
  AUTO_DOWNLOAD_ALL,
  AUTO_DOWNLOAD_STICKER,
  MAX_RECONNECT_DELAY_MS,
  QR_TIMEOUT_MS,
} from '@/config';
import { sql } from '@/db/client';
import { logEvent, logSend } from '@/db/log';
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
  saveLidMappings,
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

let cachedBaileysVersion: [number, number, number] | null = null;
async function getBaileysVersion(): Promise<[number, number, number]> {
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedBaileysVersion = version as [number, number, number];
    try {
      await sql`INSERT INTO auth_state (key, value) VALUES ('baileys-version', ${JSON.stringify(cachedBaileysVersion)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
    } catch {}
    return cachedBaileysVersion;
  } catch (e) {
    if (cachedBaileysVersion) {
      void logEvent('baileys', 'fetchVersion', 'warn', {}, String(e));
      return cachedBaileysVersion;
    }
    try {
      const rows = await sql<
        { value: string }[]
      >`SELECT value FROM auth_state WHERE key = 'baileys-version' LIMIT 1`;
      if (rows[0]?.value) {
        const v = JSON.parse(rows[0].value);
        if (Array.isArray(v) && v.length === 3) {
          cachedBaileysVersion = v as [number, number, number];
          return cachedBaileysVersion;
        }
      }
    } catch {}
    void logEvent(
      'baileys',
      'fetchVersion',
      'warn',
      {},
      `fallback to hardcoded: ${String(e)}`,
    );
    return [2, 3000, 1043857760] as [number, number, number];
  }
}

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
  private static sseListeners = new Set<(id: number, data: string) => void>();
  private static sseIdCounter = 0;
  private static sseBuffer: Array<{ id: number; data: string }> = [];

  private static sseLogger = P({ level: 'warn' }).child({
    module: 'sse',
  });

  /** Broadcast an event to all connected /sse/live clients. */
  static emitToSse(data: string): void {
    const id = ++WhatsAppSession.sseIdCounter;
    WhatsAppSession.sseBuffer.push({ id, data });
    if (WhatsAppSession.sseBuffer.length > 100)
      WhatsAppSession.sseBuffer.shift();
    for (const cb of WhatsAppSession.sseListeners) {
      try {
        cb(id, data);
      } catch (e) {
        WhatsAppSession.sseLogger.warn(
          { err: e, dataPreview: data.slice(0, 200) },
          'SSE callback error',
        );
        void logEvent(
          'sse',
          'emit_error',
          'warn',
          { dataPreview: data.slice(0, 200) },
          String(e),
        );
      }
    }
  }

  static getBufferedEvents(
    sinceId: number,
  ): Array<{ id: number; data: string }> {
    return WhatsAppSession.sseBuffer.filter((e) => e.id > sinceId);
  }

  static subscribeSse(
    callback: (id: number, data: string) => void,
  ): () => void {
    WhatsAppSession.sseListeners.add(callback as never);
    return () => WhatsAppSession.sseListeners.delete(callback as never);
  }

  public phoneNumber: string | null;

  private logger: P.Logger;

  private socket: WASocket | null = null;
  private isLoggedIn: boolean = false;
  private qrCode: string | null = null;
  private pairingCode: string | null = null;
  private timeout: NodeJS.Timeout | undefined = undefined;
  private qrTimeout: NodeJS.Timeout | undefined = undefined;
  private heartbeatInterval: NodeJS.Timeout | undefined = undefined;

  private messageQueue = new PQueue({ concurrency: 1 });
  private mediaQueue = new PQueue({ concurrency: 3 });
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 5_000;

  private _connectionState: WAConnectionState = 'close';
  private _isNewSession: boolean = false;
  private connectMutex: Promise<WASocket> | null = null;
  private reconnectAttempts = 0;

  /** FIFO of user-attribution pending for outgoing messages. */
  private pendingSend: Array<{
    jid: string;
    msgId: string | null;
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

  private getBackoffDelay(): number {
    const base = Math.min(
      1000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;
    return base + randomInt(0, 1000);
  }

  async connect(phoneNumber: string | null = null): Promise<WASocket> {
    if (this.connectMutex) return this.connectMutex;
    if (
      this.socket &&
      !this.connectMutex &&
      (this._connectionState === 'open' ||
        this._connectionState === 'connecting')
    ) {
      this.logger.info('Socket already connected. Reusing existing connection');
      return this.socket;
    }

    if (phoneNumber) {
      this.phoneNumber = validatePhoneNumber(phoneNumber) ?? null;
    }

    const promise = new Promise<WASocket>(async (resolve, reject) => {
      try {
        const { state, saveCreds, clearCreds } =
          await initPostgresAuthState(sql);
        const version = await getBaileysVersion();

        const sock = makeWASocket({
          version: version,
          logger: this.logger,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, this.logger),
          },
          browser: ['Windows', 'Edge', '128.0.0'],
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
            const full = row?.message as unknown as
              proto.IWebMessageInfo | undefined;
            // Return inner IMessage for Baileys decrypt (messageSecret inside messageContextInfo)
            if (full?.message) return full.message as unknown as proto.IMessage;
            if (full) return full as unknown as proto.IMessage;
            return undefined;
          },
        });

        this.socket = sock;
        this.isLoggedIn = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (upsert) => {
          for (const msg of upsert.messages) {
            if (!msg.key?.id || !msg.key?.remoteJid) continue;

            // Skip system messages that should not be stored as chat bubbles
            const _innerType = Object.keys(msg.message ?? {})[0];

            // Handle MESSAGE_EDIT from secretEncryptedMessage (E2EE, Baileys tidak auto-decrypt)
            const secEnc = (msg.message as any)?.secretEncryptedMessage;
            if (
              secEnc?.secretEncType === 2 ||
              secEnc?.secretEncType === 'MESSAGE_EDIT' ||
              secEnc?.targetMessageKey
            ) {
              const targetKey = secEnc.targetMessageKey;
              if (targetKey?.id && targetKey?.remoteJid) {
                const targetStoreId = `${targetKey.remoteJid}-${targetKey.id}`;
                try {
                  const { getMessage } = await import('./message-store');
                  const existing = await getMessage(targetStoreId);
                  const originalText = existing?.message_text || '';
                  let newEditedText = originalText;
                  let editedMsgForDb: any = null;
                  try {
                    const { decryptEditedMessage } =
                      await import('./decrypt-edit');
                    const rawMsg = existing?.message as any;
                    const secret =
                      rawMsg?.message?.messageContextInfo?.messageSecret ??
                      rawMsg?.messageContextInfo?.messageSecret ??
                      (rawMsg as any)?.messageSecret;
                    if (secret) {
                      const sender =
                        msg.key.participant ||
                        (msg as any).participant ||
                        msg.key.remoteJid;
                      const decrypted = decryptEditedMessage(
                        secEnc as never,
                        secret as never,
                        sender,
                      );
                      const editedInner = (decrypted as any)?.protocolMessage
                        ?.editedMessage;
                      if (editedInner) {
                        newEditedText =
                          extractText({ message: editedInner } as never) ||
                          originalText;
                        editedMsgForDb = {
                          key: {
                            ...((existing?.message as any)?.key ?? {}),
                            id: targetKey.id,
                            remoteJid: targetKey.remoteJid,
                          },
                          message: editedInner,
                          messageTimestamp: msg.messageTimestamp,
                        };
                      }
                    }
                  } catch (e) {
                    this.logger.debug({ e }, 'E2EE decrypt failed');
                  }
                  {
                    const _phone = (
                      msg.key.participantAlt ||
                      (msg as any).participant ||
                      msg.key.participant ||
                      targetKey.remoteJid ||
                      ''
                    )
                      .split('@')[0]
                      .split(':')[0];
                    const _jam = new Date().toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    });
                    this.logger.info(
                      `Pesan Edit : ${_phone} : ${originalText} : ${newEditedText} - ${_jam}`,
                    );
                  }
                  if (editedMsgForDb) {
                    await updateMessageEdited(
                      targetKey.remoteJid,
                      targetKey.id,
                      editedMsgForDb,
                    );
                  } else {
                    const { sql } = await import('@/db/client');
                    await sql`
                      UPDATE messages SET
                        original_text = COALESCE(original_text, message_text),
                        original_message = COALESCE(original_message, message),
                        edited_at = COALESCE(edited_at, ${Date.now()})
                      WHERE id = ${targetStoreId}
                    `;
                  }
                  WhatsAppSession.emitToSse(
                    JSON.stringify({
                      type: 'message_edited',
                      data: {
                        chatJid: targetKey.remoteJid,
                        messageId: targetKey.id,
                        text: newEditedText,
                        originalText,
                      },
                    }),
                  );
                } catch (e) {
                  this.logger.error({ e }, '[EDIT E2EE] failed');
                }
              }
              continue;
            }

            if (
              _innerType === 'secretEncryptedMessage' ||
              _innerType === 'senderKeyDistributionMessage'
            ) {
              void logEvent(
                'baileys',
                'decrypt',
                'warn',
                {
                  chatJid: msg.key.remoteJid,
                  participant: msg.key.participant,
                  id: msg.key.id,
                  type: _innerType,
                },
                'skipped system message',
              );
              continue;
            }

            // protocolMessage: edit / delete-for-everyone
            const pm = msg.message?.protocolMessage;
            if (pm) {
              const targetJid = pm.key?.remoteJid ?? msg.key.remoteJid;
              const targetId = pm.key?.id;
              if (targetJid && targetId) {
                if (pm.type === 0) {
                  // REVOKE -> delete for everyone
                  let _hapusOrig = '';
                  try {
                    const { getMessage: _gm } = await import('./message-store');
                    const _ex = await _gm(`${targetJid}-${targetId}`);
                    _hapusOrig = _ex?.message_text || '';
                  } catch (e) {
                    this.logger.debug({ e }, 'get original text failed');
                  }
                  try {
                    await markMessageDeleted(targetJid, targetId);
                    WhatsAppSession.emitToSse(
                      JSON.stringify({
                        type: 'message_deleted',
                        data: { chatJid: targetJid, messageId: targetId },
                      }),
                    );
                  } catch (e) {
                    this.logger.debug({ e }, 'mark deleted failed');
                  }
                  {
                    const _phone = (
                      msg.key.participantAlt ||
                      (msg as any).participant ||
                      targetJid ||
                      ''
                    )
                      .split('@')[0]
                      .split(':')[0];
                    const _jam = new Date().toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    });
                    this.logger.info(
                      `Pesan Hapus : ${_phone} : dihapus - ${_jam}`,
                    );
                  }
                } else if (pm.type === 14 && pm.editedMessage) {
                  // MESSAGE_EDIT -> update stored message
                  let editedMsg = pm.editedMessage as any;
                  if (editedMsg?.ephemeralMessage?.message)
                    editedMsg = editedMsg.ephemeralMessage.message;
                  if (editedMsg?.viewOnceMessage?.message)
                    editedMsg = editedMsg.viewOnceMessage.message;
                  if (editedMsg?.viewOnceMessageV2?.message)
                    editedMsg = editedMsg.viewOnceMessageV2.message;
                  const newEditedText =
                    extractText(
                      editedMsg?.message ? editedMsg : { message: editedMsg },
                    ) || '';
                  const edited = {
                    ...msg,
                    key: { ...msg.key, id: targetId, remoteJid: targetJid },
                    message: editedMsg,
                  };
                  let originalText = '';
                  try {
                    const { getMessage } = await import('./message-store');
                    const existing = await getMessage(
                      `${targetJid}-${targetId}`,
                    );
                    if (existing) originalText = existing.message_text || '';
                  } catch (e) {
                    this.logger.debug(
                      { e },
                      'get original text for edit failed',
                    );
                  }
                  await updateMessageEdited(targetJid, targetId, edited).catch(
                    () => {},
                  );
                  WhatsAppSession.emitToSse(
                    JSON.stringify({
                      type: 'message_edited',
                      data: {
                        chatJid: targetJid,
                        messageId: targetId,
                        text: newEditedText,
                        originalText: originalText || '',
                      },
                    }),
                  );
                  {
                    const _phone = (
                      msg.key.participantAlt ||
                      (msg as any).participant ||
                      msg.key.participant ||
                      targetJid ||
                      ''
                    )
                      .split('@')[0]
                      .split(':')[0];
                    const _jam = new Date().toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    });
                    this.logger.info(
                      `Pesan Edit : ${_phone} : ${originalText} : ${newEditedText} - ${_jam}`,
                    );
                  }
                }
              }
              continue;
            }

            let sentByUser: string | undefined;
            let senderName: string | null = null;

            if (msg.key.fromMe) {
              // Prefer exact msgId match (Fix 4); fallback to jid-only for legacy pending entries.
              let idx = this.pendingSend.findIndex(
                (p) => p.jid === msg.key.remoteJid && p.msgId === msg.key.id,
              );
              if (idx < 0) {
                idx = this.pendingSend.findIndex(
                  (p) => p.jid === msg.key.remoteJid && p.msgId === null,
                );
              }
              if (idx < 0) {
                idx = this.pendingSend.findIndex(
                  (p) => p.jid === msg.key.remoteJid,
                );
              }
              if (idx >= 0) {
                const pending = this.pendingSend.splice(idx, 1)[0];
                if (pending) {
                  sentByUser = pending.sentBy;
                  senderName = pending.senderName;
                }
              }
              try {
                await upsertMessage(msg, {
                  sentByUser,
                  senderName,
                });
              } catch (e) {
                void logEvent(
                  'baileys',
                  'decrypt',
                  'error',
                  {
                    chatJid: msg.key.remoteJid,
                    participant: msg.key.participant,
                    id: msg.key.id,
                  },
                  String(e),
                );
              }
            } else {
              const targetJid = msg.key.participant || msg.key.remoteJid;
              senderName = targetJid
                ? await this.getContactName(targetJid)
                : null;
              try {
                await upsertMessage(msg, { senderName });
              } catch (e) {
                void logEvent(
                  'baileys',
                  'decrypt',
                  'error',
                  {
                    chatJid: msg.key.remoteJid,
                    participant: msg.key.participant,
                    id: msg.key.id,
                  },
                  String(e),
                );
              }
            }

            // Simple log: Pesan Baru
            {
              const _rawPhone =
                msg.key?.participantAlt ||
                msg.key?.participant ||
                msg.key?.remoteJid ||
                '';
              const _parts = _rawPhone.split('@');
              const _phone = (_parts[0] ?? '').split(':')[0];
              const _text =
                extractText(msg as never) ||
                Object.keys((msg as any).message ?? {})[0] ||
                '';
              const _jam = new Date().toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              });
              this.logger.info(`Pesan Baru ${_phone} : ${_text} - ${_jam}`);
            }

            // Auto-download media honoring AUTO_DOWNLOAD_ALL / STICKER flags (without size limit)
            if (this.socket) {
              const mtype = Object.keys(msg.message ?? {})[0] ?? 'unknown';
              const shouldDownload =
                AUTO_DOWNLOAD_ALL ||
                (mtype === 'stickerMessage' && AUTO_DOWNLOAD_STICKER);
              if (shouldDownload) {
                this.mediaQueue
                  .add(() =>
                    downloadMedia(msg, this.socket as never).catch((e) => {
                      void logEvent(
                        'media',
                        'autoDownload',
                        'warn',
                        { mtype, id: msg.key?.id },
                        String(e),
                      );
                    }),
                  )
                  .catch(() => {});
              }
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
              WhatsAppSession.emitToSse(
                JSON.stringify({ type: 'contact', data: { jid: c.id } }),
              );
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
            // Evict oldest entries if map exceeds 500
            if (labelNames.size > 500) {
              const first = labelNames.keys().next().value;
              if (first) labelNames.delete(first);
            }
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

        sock.ev.on('messages.update', async (updates) => {
          for (const u of updates) {
            // Phase1: log-only check for editedMessage / protocolMessage
            const protoMsg = (u.update as any)?.message?.protocolMessage;
            const editedDirect = (u.update as any)?.message?.editedMessage;
            const anyMsg = (u.update as any)?.message;
            if (protoMsg || editedDirect || anyMsg) {
              this.logger.debug({ key: u.key }, 'messages.update deteksi');
            }
            // TODO Phase2: if protoMsg?.type===14 -> extractText({message: editedMessage}) + DB + SSE

            // Handle status updates
            const status = (u as any).update?.status;
            if (status && u.key?.remoteJid) {
              // WebMessageInfo.Status: 2 SERVER_ACK(sent), 3 DELIVERY_ACK, 4 READ, 5 PLAYED
              const label =
                status === 4
                  ? 'read'
                  : status === 3
                    ? 'delivered'
                    : status === 5
                      ? 'played'
                      : 'sent';
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

        sock.ev.on('message-receipt.update', async (updates) => {
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
            // If our outgoing message was read by remote, mark incoming messages as read
            if (receipt?.type === 'read' && u.key?.remoteJid) {
              const { markChatRead: mcr } = await import('./message-store');
              mcr(u.key.remoteJid).catch(() => {});
              WhatsAppSession.emitToSse(
                JSON.stringify({
                  type: 'chat_read',
                  data: { jid: u.key.remoteJid, readBy: null, whatsapp: false },
                }),
              );
            }
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
            WhatsAppSession.emitToSse(
              JSON.stringify({ type: 'group', data: { id: g.id } }),
            );
          }
        });

        sock.ev.on('group-participants.update', (update) => {
          if (!update.id) return;
          saveGroupFromSocket(update.id);
          WhatsAppSession.emitToSse(
            JSON.stringify({ type: 'group', data: { id: update.id } }),
          );
        });

        sock.ev.on(
          'messaging-history.set',
          async ({ messages, contacts, chats, lidPnMappings }) => {
            try {
              const validMessages = messages.filter(
                (m) => m.key?.remoteJid && m.key?.id,
              );
              // Chunked upserts to avoid DB pool saturation (7000 concurrent -> OOM)
              const chunk = async <T>(
                items: (() => Promise<T>)[],
                size: number,
              ) => {
                for (let i = 0; i < items.length; i += size) {
                  await Promise.all(
                    items.slice(i, i + size).map((fn) => fn().catch(() => {})),
                  );
                }
              };
              const msgTasks = validMessages.map((m) => () => upsertMessage(m));
              const contactTasks = contacts.map(
                (c) => () =>
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
              );
              await chunk(msgTasks, 100);
              await chunk(contactTasks, 100);
              await saveLidMappings(lidPnMappings ?? []).catch(() => {});
              // Auto-download media from history honoring flags, concurrency 3
              if (sock && (AUTO_DOWNLOAD_ALL || AUTO_DOWNLOAD_STICKER)) {
                const mediaMessages = validMessages.filter((m) => {
                  const t = Object.keys(m.message ?? {})[0] ?? '';
                  if (AUTO_DOWNLOAD_ALL) {
                    return [
                      'imageMessage',
                      'videoMessage',
                      'audioMessage',
                      'documentMessage',
                      'stickerMessage',
                      'viewOnceMessage',
                      'viewOnceMessageV2',
                    ].includes(t);
                  }
                  return t === 'stickerMessage';
                });
                for (let i = 0; i < mediaMessages.length; i += 3) {
                  await Promise.all(
                    mediaMessages
                      .slice(i, i + 3)
                      .map((m) =>
                        this.mediaQueue
                          .add(() =>
                            downloadMedia(m, sock as never).catch(() => {}),
                          )
                          .catch(() => {}),
                      ),
                  );
                  if (i + 3 < mediaMessages.length) await Bun.sleep(100);
                }
              }
            } catch (e) {
              this.logger.debug({ e }, 'history sync chunk failed');
            }
            WhatsAppSession.emitToSse(
              JSON.stringify({ type: 'history_done', data: null }),
            );
            void chats;
          },
        );

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
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const code = await sock.requestPairingCode(this.phoneNumber);
                  this.logger.info({ code }, 'Pairing code generated');
                  this.pairingCode = code;
                  this.emit('pairing-code', code);
                  break;
                } catch (error) {
                  if (attempt === 3) {
                    this.logger.error(
                      { error },
                      'Failed to request pairing code',
                    );
                    this.emit(
                      'error',
                      error instanceof Error ? error : new Error(String(error)),
                    );
                  } else {
                    await Bun.sleep(5000);
                  }
                }
              }
            }
            this.broadcastState();
          }

          if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output
              ?.statusCode;
            void logEvent(
              'baileys',
              'connection.update',
              'warn',
              { connection, statusCode, hasQr: !!qr },
              (lastDisconnect?.error as Error)?.message ??
                String(lastDisconnect?.error ?? ''),
            );
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
                setTimeout(
                  () => this.connect().catch((err) => this.emit('error', err)),
                  this.getBackoffDelay(),
                );
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
                setTimeout(
                  () => this.connect().catch((err) => this.emit('error', err)),
                  this.getBackoffDelay(),
                );
                break;

              case 998:
                this.cleanup(true);
                this.emit('session-stopped', 'disconnectedByUser');
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
                // Unknown / transient close codes: reconnect with backoff (was 500-only)
                this.cleanup();
                setTimeout(
                  () => this.connect().catch((err) => this.emit('error', err)),
                  this.getBackoffDelay(),
                );
            }
          } else if (connection === 'open') {
            void logEvent(
              'baileys',
              'connection.update',
              'info',
              { connection: 'open', isLoggedIn: true },
              { user: (sock as any).user?.id ?? null },
            );
            this.reconnectAttempts = 0;
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
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit('error', err);
        reject(err);
      }
    });
    this.connectMutex = promise;
    promise
      .finally(() => {
        this.connectMutex = null;
      })
      .catch(() => {});
    return promise;
  }

  private async getContactName(jid: string): Promise<string | null> {
    const rows = await sql<{ name: string | null }[]>`
      SELECT name FROM contacts WHERE jid = ${jid} LIMIT 1
    `;
    return rows[0]?.name ?? jid.split('@')[0] ?? null;
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
    (this.logger as any).closeLog?.();
  }

  private cleanup(_fullCleanup: boolean = false): void {
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (e) {
        this.logger.debug({ e }, 'socket end failed');
      }
    }
    this.socket = null;
    this.isLoggedIn = false;
    this.qrCode = null;
    this.pairingCode = null;
    clearTimeout(this.qrTimeout);
    this.qrTimeout = undefined;
    this.messageQueue.clear();
    this.mediaQueue.clear();
    this.pendingSend = [];
    this.connectMutex = null;
    this._connectionState = 'close';
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = undefined;
    this._isNewSession = false;
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
    attribution?: { sentBy: string; senderName: string },
  ): Promise<any> {
    let pending: {
      jid: string;
      msgId: string | null;
      sentBy: string;
      senderName: string;
    } | null = null;
    if (attribution) {
      pending = {
        jid,
        msgId: null,
        sentBy: attribution.sentBy,
        senderName: attribution.senderName,
      };
      this.pendingSend.push(pending);
    }

    const send = async (): Promise<unknown> => {
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
      }

      const result = await this.socket.sendMessage(
        jid,
        content,
        options ?? undefined,
      );
      // Log raw Baileys return for future reference (requested by user).
      void logSend(jid, result, attribution ?? null);
      void logEvent(
        'baileys',
        'sendMessage',
        'info',
        {
          jid,
          attribution,
          isLoggedIn: this.isLoggedIn,
          connectionState: this._connectionState,
        },
        result,
      );
      // Patch pending entry with the actual key.id so the echo can be matched exactly.
      if (pending && result?.key?.id) {
        pending.msgId = String(result.key.id);
      }
      return result;
    };

    const sendWithRetry = async () => {
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
        try {
          return await send();
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          void logEvent(
            'baileys',
            'sendMessage',
            'error',
            {
              jid,
              attempt,
              attribution,
              isLoggedIn: this.isLoggedIn,
              connectionState: this._connectionState,
            },
            String(lastError),
          );
          if (attempt < this.MAX_RETRIES) {
            await Bun.sleep(this.RETRY_DELAY);
          }
        }
      }
      // Exhausted retries: remove pending attribution so it does not leak to a later message.
      if (pending) {
        const idx = this.pendingSend.indexOf(pending);
        if (idx >= 0) this.pendingSend.splice(idx, 1);
      }
      throw lastError;
    };

    const MAX_QUEUED = Number(Bun.env.SEND_QUEUE_MAX ?? 500);
    if (this.messageQueue.size >= MAX_QUEUED) {
      if (pending) {
        const idx = this.pendingSend.indexOf(pending);
        if (idx >= 0) this.pendingSend.splice(idx, 1);
      }
      throw new Error(`Send queue full (${MAX_QUEUED}), try again later`);
    }

    return await this.messageQueue.add(sendWithRetry);
  }
}
