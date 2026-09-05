import { authUser } from '@/auth/middleware';
import { MEDIA_PATH } from '@/config';
import { SessionHolder } from '@/whatsapp';
import { downloadMedia } from '@/whatsapp/media-store';
import {
  extractMediaMeta,
  getMessage,
  normalizeMessageContent,
  type MediaMeta,
} from '@/whatsapp/message-store';
import { file } from 'bun';
import { Elysia, t } from 'elysia';
import { copyFile, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const holder = SessionHolder.getInstance();

const CONVERTIBLE_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'text/rtf',
  'application/rtf',
]);

async function convertToPdf(
  srcPath: string,
  messageId: string,
): Promise<string | null> {
  const convertedDir = join(MEDIA_PATH, 'converted');
  if (!existsSync(convertedDir)) {
    await mkdir(convertedDir, { recursive: true });
  }
  const outPdf = join(convertedDir, `${messageId}.pdf`);
  if (existsSync(outPdf)) return outPdf;
  const absSrc = srcPath.startsWith('/')
    ? srcPath
    : join(process.cwd(), srcPath);
  const absOut = join(process.cwd(), convertedDir);
  // Copy source with messageId name so LibreOffice outputs messageId.pdf
  const srcExt = extname(absSrc) || '.bin';
  const tmpSrc = join(absOut, `${messageId}${srcExt}`);
  try {
    await new Promise<void>((resolve, reject) => {
      copyFile(absSrc, tmpSrc, (err) => (err ? reject(err) : resolve()));
    });
    const proc = Bun.spawn(
      [
        '/snap/bin/libreoffice',
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        absOut,
        tmpSrc,
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 30_000, cwd: process.cwd() },
    );
    const exit = await proc.exited;
    if (exit === 0 && existsSync(outPdf)) return outPdf;
  } catch {}
  return null;
}

export const mediaRoutes = new Elysia({ prefix: '/media' })
  .use(authUser)
  .guard({
    beforeHandle({ user, set }) {
      if (!user) {
        set.status = 401;
        return { success: false, message: 'Unauthorized' };
      }
    },
  })
  .get(
    '/:chatJid/:messageId',
    async ({ params, query, set }) => {
      const row = await getMessage(`${params.chatJid}-${params.messageId}`);
      if (!row) {
        set.status = 404;
        return { success: false, message: 'Message not found' };
      }

      const meta = normalizeMessageContent(row.message);
      const mediaType = [
        'image',
        'video',
        'audio',
        'document',
        'sticker',
        'ptv',
      ].find((t) => meta?.[`${t}Message`]);
      if (!mediaType) {
        set.status = 400;
        return { success: false, message: 'Not a media message' };
      }

      const mime = meta[`${mediaType}Message`]?.mimetype ?? null;
      const path = row.media_path as string | null;

      // Ensure file is on disk (download if needed)
      let filePath = path && existsSync(path) ? path : null;
      if (!filePath && (query.download === '1' || query.convert === 'pdf')) {
        const session = holder.get();
        const socket = session?.getSocket();
        if (!socket) {
          set.status = 400;
          return { success: false, message: 'Session not connected' };
        }
        const saved = await downloadMedia(row.message, socket as never);
        if (saved && existsSync(saved)) {
          filePath = saved;
        } else {
          set.status = 404;
          return {
            success: false,
            message: 'Media unavailable or expired',
          };
        }
      }

      // Convert to PDF on demand
      if (
        query.convert === 'pdf' &&
        filePath &&
        CONVERTIBLE_MIMES.has(mime ?? '')
      ) {
        const pdfPath = await convertToPdf(filePath, params.messageId);
        if (pdfPath) {
          set.headers['Content-Type'] = 'application/pdf';
          set.headers['Content-Disposition'] = 'inline';
          return file(pdfPath);
        }
      }

      // Serve cached / downloaded file
      if (filePath) {
        set.headers['Content-Type'] = mime ?? 'application/octet-stream';
        return file(filePath);
      }

      // Metadata only (blur / download prompt)
      const mediaMsg = meta[`${mediaType}Message`];
      const thumb =
        typeof mediaMsg?.jpegThumbnail === 'string'
          ? mediaMsg.jpegThumbnail
          : mediaMsg?.jpegThumbnail
            ? Buffer.from(mediaMsg.jpegThumbnail).toString('base64')
            : null;
      return {
        success: true,
        data: {
          mediaType,
          mime,
          size: mediaMsg?.fileLength ?? null,
          duration: mediaMsg?.seconds ?? null,
          width: mediaMsg?.width ?? null,
          height: mediaMsg?.height ?? null,
          caption: mediaMsg?.caption ?? null,
          fileName: mediaMsg?.fileName ?? null,
          hasDownloaded: !!path && existsSync(path),
          jpegThumbnail: thumb,
        },
      };
    },
    {
      params: t.Object({
        chatJid: t.String({ minLength: 1 }),
        messageId: t.String({ minLength: 1 }),
      }),
      query: t.Object({
        download: t.Optional(t.String()),
        convert: t.Optional(t.String()),
      }),
    },
  );
