import { verifyToken } from '@/auth/middleware';
import { WhatsAppSession } from '@/whatsapp';
import { Elysia, t } from 'elysia';

export const sseRoutes = new Elysia({ prefix: '/sse' }).get(
  '/live',
  async ({ request, query, set }) => {
    // Allow token via query parameter for EventSource (which doesn't support cookies)
    let user = null;
    if (query.token) {
      user = await verifyToken(query.token);
    }
    if (!user) {
      set.status = 401;
      return { success: false, message: 'Unauthorized' };
    }

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      if (keepalive) clearInterval(keepalive);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        unsubscribe = WhatsAppSession.subscribeSse((data: string) => {
          if (closed) return;
          if (controller.desiredSize !== null && controller.desiredSize <= 0)
            return;
          try {
            controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
          } catch {}
        });

        keepalive = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(new TextEncoder().encode(':\n\n'));
          } catch {}
        }, 30000);

        request.signal.addEventListener('abort', () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          if (keepalive) clearInterval(keepalive);
        });
      },
      cancel: () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (keepalive) clearInterval(keepalive);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  },
  {
    query: t.Object({
      token: t.Optional(t.String()),
    }),
  },
);
