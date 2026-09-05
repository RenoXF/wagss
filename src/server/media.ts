import { authUser } from '@/auth/middleware';
import { SessionHolder } from '@/whatsapp';
import { downloadMedia } from '@/whatsapp/media-store';
import { getMessage } from '@/whatsapp/message-store';
import { file } from 'bun';
import { Elysia, t } from 'elysia';
import { existsSync } from 'node:fs';

const holder = SessionHolder.getInstance();

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

      let meta = (row.message as any)?.message;
      if (meta?.ephemeralMessage?.message) meta = meta.ephemeralMessage.message;
      if (meta?.viewOnceMessage?.message) meta = meta.viewOnceMessage.message;
      if (meta?.viewOnceMessageV2?.message)
        meta = meta.viewOnceMessageV2.message;
      if (meta?.documentWithCaptionMessage?.message)
        meta = meta.documentWithCaptionMessage.message;
      const mediaType = ['image', 'video', 'audio', 'document', 'sticker'].find(
        (t) => meta?.[`${t}Message`],
      );
      if (!mediaType) {
        set.status = 400;
        return { success: false, message: 'Not a media message' };
      }

      const mime = meta[`${mediaType}Message`]?.mimetype ?? null;
      const path = row.media_path as string | null;

      if (path && existsSync(path)) {
        set.headers['Content-Type'] = mime ?? 'application/octet-stream';
        return file(path);
      }

      // On-demand download
      if (query.download === '1') {
        const session = holder.get();
        const socket = session?.getSocket();
        if (!socket) {
          set.status = 400;
          return { success: false, message: 'Session not connected' };
        }
        const saved = await downloadMedia(row.message, socket as never);
        if (saved && existsSync(saved)) {
          set.headers['Content-Type'] = mime ?? 'application/octet-stream';
          return file(saved);
        }
        set.status = 404;
        return {
          success: false,
          message: 'Media unavailable or expired',
        };
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
      }),
    },
  );
