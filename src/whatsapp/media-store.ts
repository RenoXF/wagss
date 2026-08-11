import { MEDIA_PATH } from '@/config';
import { logger } from '@/logger';
import { downloadMediaMessage } from 'baileys';
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

/**
 * Download a media message's bytes on demand from WhatsApp and cache them
 * to disk under MEDIA_PATH. Returns the stored relative path, or null when
 * the download fails (expired keys, view-once, etc.).
 */
export async function downloadMedia(
  msg: any,
  socket: { reuploadRequest?: (m: any) => Promise<any> },
): Promise<string | null> {
  const m = msg?.message;
  const type = ['image', 'video', 'audio', 'document', 'sticker'].find(
    (t) => m?.[`${t}Message`],
  );
  if (!type || !msg?.key?.id || !msg?.key?.remoteJid) return null;

  try {
    const me = (m as any)[`${type}Message`];
    if (me?.viewOnce) return null;

    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      reuploadRequest: (mm: any) => socket.reuploadRequest?.(mm),
      logger,
    } as never);

    const now = new Date();
    const dir = join(
      MEDIA_PATH,
      type,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    );
    await mkdir(dir, { recursive: true });

    const rnd = Math.random().toString(36).slice(2, 8);
    const file = `${msg.key.id}-${rnd}.${toExt(me?.mimetype)}`;
    const abs = join(dir, file);
    await writeFile(abs, buffer);

    const rel = `media/${type}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${file}`;
    // persist path on the message row
    const stored = join(MEDIA_PATH, rel);
    await setMediaPath(msgId(msg.key.remoteJid, msg.key.id), stored);
    return stored;
  } catch (err) {
    logger.debug({ err, id: msg.key.id }, '[media] download failed');
    return null;
  }
}
export const mediaToExt = toExt;
