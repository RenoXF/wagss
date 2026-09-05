import { JWT_COOKIE } from '@/auth/jwt';
import { readCookie, verifyToken } from '@/auth/middleware';
import { WhatsAppSession } from '@/whatsapp';
import { Elysia, t } from 'elysia';

export const sseRoutes = new Elysia({ prefix: '/sse' }).get(
  '/live',
  async ({ request, query, set }) => {
    // Token via query param OR via cookie (EventSource sends cookies
    // automatically for same-origin).
    let user = null;
    const cookieToken = readCookie(request.headers, JWT_COOKIE);
    if (query.token) user = await verifyToken(query.token);
    else if (cookieToken) user = await verifyToken(cookieToken);
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

    const encoder = new TextEncoder();
    // Replay missed events via Last-Event-ID
    const lastEventIdHeader = request.headers.get('last-event-id');
    const sinceId = lastEventIdHeader
      ? Number.parseInt(lastEventIdHeader, 10)
      : 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send retry hint
        try {
          controller.enqueue(encoder.encode('retry: 3000\n\n'));
        } catch {}
        // Replay buffered events
        if (sinceId > 0) {
          for (const ev of WhatsAppSession.getBufferedEvents(sinceId)) {
            try {
              controller.enqueue(
                encoder.encode(`id: ${ev.id}\ndata: ${ev.data}\n\n`),
              );
            } catch {}
          }
        }

        unsubscribe = WhatsAppSession.subscribeSse(
          (id: number, data: string) => {
            if (closed) return;
            // Simple backpressure: drop if client is slow (avoid blocking Baileys loop)
            if (controller.desiredSize !== null && controller.desiredSize <= 0)
              return;
            try {
              controller.enqueue(
                encoder.encode(`id: ${id}\ndata: ${data}\n\n`),
              );
            } catch {}
          },
        );

        keepalive = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(':\n\n'));
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
        'X-Accel-Buffering': 'no',
      },
    });
  },
  {
    query: t.Object({
      token: t.Optional(t.String()),
    }),
  },
);
