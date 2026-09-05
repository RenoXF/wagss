import { MEDIA_PATH } from '@/config';
import { logger } from '@/logger';
import { downloadMediaMessage } from 'baileys';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { msgId, setMediaPath } from './message-store';

const toExt = (mime: string | null | undefined): string => {
  if (!mime) return 'bin';
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/opus': 'opus',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'docx',
  };
  if (map[mime]) return map[mime]!;
  const fallback = mime.split('/')[1];
  return fallback ? fallback.replace(/[^\w.-]/g, '') : 'bin';
};

const typeToFolder: Record<string, string> = {
  image: 'images',
  video: 'videos',
  audio: 'audios',
  document: 'documents',
  sticker: 'stickers',
};

function unwrapMedia(msg: any): { inner: any; type: string | null } {
  let m = msg?.message;
  if (!m) return { inner: null, type: null };
  // Unwrap wrappers
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message)
    m = m.documentWithCaptionMessage.message;
  const type = ['image', 'video', 'audio', 'document', 'sticker'].find(
    (t) => m?.[`${t}Message`],
  );
  if (!type) return { inner: null, type: null };
  return { inner: (m as any)[`${type}Message`], type };
}

function sanitizeFileName(name: string): string {
  // Remove path traversal, control chars, keep readable
  let s = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 100) {
    const extIdx = s.lastIndexOf('.');
    if (extIdx > 0) {
      const ext = s.slice(extIdx);
      s = s.slice(0, 100 - ext.length) + ext;
    } else {
      s = s.slice(0, 100);
    }
  }
  return s || 'file';
}

/**
 * Download a media message's bytes on demand from WhatsApp and cache them
 * to disk under MEDIA_PATH. Returns the stored absolute path, or null when
 * the download fails (expired keys, etc.). View-once is now downloaded too.
 * Documents preserve original fileName with dedup suffix _1.
 */
export async function downloadMedia(
  msg: any,
  socket: { reuploadRequest?: (m: any) => Promise<any> },
): Promise<string | null> {
  if (!msg?.key?.id || !msg?.key?.remoteJid) return null;

  const { inner: me, type } = unwrapMedia(msg);
  if (!type || !me) return null;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      reuploadRequest: (mm: any) => socket.reuploadRequest?.(mm),
      logger,
    } as never);

    const now = new Date();
    const folder = typeToFolder[type] ?? type;
    const dir = join(
      MEDIA_PATH,
      folder,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    );
    await mkdir(dir, { recursive: true });

    let file: string;
    if (type === 'document') {
      const rawName: string | undefined =
        me.fileName ||
        (msg?.message?.documentWithCaptionMessage?.message?.documentMessage
          ?.fileName as string | undefined);
      if (rawName) {
        let base = sanitizeFileName(rawName);
        // Ensure extension matches original if missing
        if (!base.includes('.') && me.mimetype) {
          base += `.${toExt(me.mimetype)}`;
        }
        let abs = join(dir, base);
        let counter = 1;
        while (existsSync(abs)) {
          const dot = base.lastIndexOf('.');
          const name = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : '';
          abs = join(dir, `${name}_${counter}${ext}`);
          counter++;
          if (counter > 100) break;
        }
        file = abs.slice(dir.length + 1);
        await writeFile(abs, buffer);
        const rel = join(
          folder,
          String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'),
          file,
        );
        const stored = join(MEDIA_PATH, rel);
        await setMediaPath(msgId(msg.key.remoteJid, msg.key.id), stored);
        return stored;
      }
    }

    const rnd = Math.random().toString(36).slice(2, 8);
    file = `${msg.key.id}-${rnd}.${toExt(me?.mimetype)}`;
    const abs = join(dir, file);
    await writeFile(abs, buffer);

    const rel = join(
      folder,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      file,
    );
    const stored = join(MEDIA_PATH, rel);
    await setMediaPath(msgId(msg.key.remoteJid, msg.key.id), stored);
    return stored;
  } catch (err) {
    logger.debug({ err, id: msg.key.id }, '[media] download failed');
    return null;
  }
}
export const mediaToExt = toExt;
