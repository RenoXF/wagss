import { sql } from './client';

export async function logEvent(
  component: string,
  operation: string,
  level: 'info' | 'warn' | 'error' = 'info',
  payload?: unknown,
  result?: unknown,
): Promise<void> {
  try {
    await sql`
      INSERT INTO error_log (component, operation, level, payload, result)
      VALUES (
        ${component}, ${operation}, ${level},
        ${payload !== undefined ? JSON.stringify(payload) : null}::jsonb,
        ${result !== undefined ? JSON.stringify(result) : null}::jsonb
      )
    `;
  } catch {
    // Logging must never break the caller.
  }
}

export async function logSend(
  jid: string,
  rawReturn: unknown,
  attribution?: unknown,
): Promise<void> {
  try {
    // Keep payload small: only key + status, not full message
    const compact =
      rawReturn && typeof rawReturn === 'object'
        ? {
            key: (rawReturn as { key?: unknown }).key ?? null,
            status: (rawReturn as { status?: unknown }).status ?? null,
            messageTimestamp:
              (rawReturn as { messageTimestamp?: unknown }).messageTimestamp ??
              null,
            hasMessageSecret:
              !!(rawReturn as { message?: unknown }) ||
              !!(rawReturn as { key?: unknown }),
          }
        : rawReturn;
    await sql`
      INSERT INTO send_log (jid, raw_return, attribution)
      VALUES (
        ${jid},
        ${compact !== undefined ? JSON.stringify(compact) : null}::jsonb,
        ${attribution !== undefined ? JSON.stringify(attribution) : null}::jsonb
      )
    `;
  } catch {
    // Best-effort.
  }
}
