import { logEvent } from '@/db/log';
import {
  type AuthenticationCreds,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from 'baileys';
import type postgres from 'postgres';

export interface IStorage {
  state: {
    creds: AuthenticationCreds;
    keys: SignalKeyStore;
  };
  saveCreds: () => void;
  clearCreds: () => void;
}

export const initPostgresAuthState = async (
  sql: postgres.Sql,
): Promise<IStorage> => {
  let generation = 0;

  const read = async (key: string): Promise<unknown | null> => {
    try {
      const rows = await sql<{ value: string }[]>`
        SELECT value FROM auth_state WHERE key = ${key} LIMIT 1
      `;
      if (rows.length > 0 && rows[0]?.value) {
        return JSON.parse(rows[0].value, BufferJSON.reviver as never);
      }
      return null;
    } catch (e) {
      void logEvent('auth_state', 'read', 'error', { key }, String(e));
      return null;
    }
  };

  const write = async (key: string, value: unknown): Promise<void> => {
    const gen = generation;
    try {
      const serialized = JSON.stringify(value, BufferJSON.replacer as never);
      await sql`
        INSERT INTO auth_state (key, value) VALUES (${key}, ${serialized})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
      `;
      if (gen !== generation) {
        void logEvent(
          'auth_state',
          'write',
          'warn',
          { key },
          'generation changed, possible race',
        );
      }
    } catch (e) {
      void logEvent('auth_state', 'write', 'error', { key }, String(e));
    }
  };

  const remove = async (key: string): Promise<void> => {
    try {
      await sql`DELETE FROM auth_state WHERE key = ${key}`;
    } catch (e) {
      void logEvent('auth_state', 'remove', 'error', { key }, String(e));
    }
  };

  const clear = async (): Promise<void> => {
    generation++;
    try {
      await sql`DELETE FROM auth_state`;
    } catch (e) {
      void logEvent('auth_state', 'clear', 'error', {}, String(e));
    }
  };

  const creds: AuthenticationCreds =
    ((await read('creds')) as AuthenticationCreds) ?? initAuthCreds();

  // Debounced saveCreds (coalesce bursts)
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave = false;
  const flushSave = async () => {
    const gen = generation;
    if (gen !== generation) return;
    try {
      const serialized = JSON.stringify(creds, BufferJSON.replacer as never);
      await sql`
        INSERT INTO auth_state (key, value) VALUES ('creds', ${serialized})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
      `;
    } catch (e) {
      void logEvent('auth_state', 'saveCreds', 'error', {}, String(e));
    } finally {
      saveTimer = null;
      if (pendingSave) {
        pendingSave = false;
        saveTimer = setTimeout(flushSave, 500);
      }
    }
  };

  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
      if (ids.length === 0) return data;
      try {
        const keysToFetch = ids.map((id) => `${type}-${id}`);
        const rows = await sql<{ key: string; value: string }[]>`
          SELECT key, value FROM auth_state WHERE key IN ${sql(keysToFetch)}
        `;
        const map = new Map(rows.map((r) => [r.key, r.value]));
        for (const id of ids) {
          const k = `${type}-${id}`;
          const raw = map.get(k);
          let value: unknown = null;
          if (raw) {
            try {
              value = JSON.parse(raw, BufferJSON.reviver as never);
            } catch {}
          }
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.create(value as never);
          }
          data[id] = value as never;
        }
        const missing = ids.filter((id) => !map.has(`${type}-${id}`));
        if (missing.length > 0) {
          void logEvent(
            'auth_state',
            'keys.get',
            'warn',
            {
              type,
              missingCount: missing.length,
              missing: missing.slice(0, 5),
            },
            null,
          );
        }
      } catch (e) {
        void logEvent(
          'auth_state',
          'keys.get',
          'error',
          { type, count: ids.length },
          String(e),
        );
        // Fallback to per-key reads
        for (const id of ids) {
          let value = await read(`${type}-${id}`);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.create(value as never);
          }
          data[id] = value as never;
        }
      }
      return data;
    },
    set: async (data: SignalDataSet) => {
      for (const category in data) {
        const entries = Object.entries(
          (data[category as keyof SignalDataTypeMap] ?? {}) as Record<
            string,
            unknown
          >,
        );
        const inserts: [string, string][] = [];
        const deletes: string[] = [];
        for (const [id, value] of entries) {
          const name = `${category}-${id}`;
          if (value) {
            const serialized = JSON.stringify(
              value,
              BufferJSON.replacer as never,
            );
            inserts.push([name, serialized]);
          } else {
            deletes.push(name);
          }
        }
        // Batch inserts 50 at a time
        for (let i = 0; i < inserts.length; i += 50) {
          const chunk = inserts.slice(i, i + 50);
          try {
            await sql`
              INSERT INTO auth_state (key, value)
              VALUES ${sql(chunk)}
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
            `;
          } catch (e) {
            void logEvent(
              'auth_state',
              'keys.set',
              'error',
              { category, batch: i / 50 },
              String(e),
            );
            // Fallback per-key
            for (const [name, serialized] of chunk) {
              try {
                await sql`
                  INSERT INTO auth_state (key, value) VALUES (${name}, ${serialized})
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
                `;
              } catch (ee) {
                void logEvent(
                  'auth_state',
                  'keys.set',
                  'error',
                  { category, name },
                  String(ee),
                );
              }
            }
          }
        }
        if (deletes.length > 0) {
          try {
            await sql`DELETE FROM auth_state WHERE key IN ${sql(deletes)}`;
          } catch (e) {
            void logEvent(
              'auth_state',
              'keys.set',
              'error',
              { category, deletes: deletes.length },
              String(e),
            );
            for (const name of deletes) {
              try {
                await sql`DELETE FROM auth_state WHERE key = ${name}`;
              } catch (ee) {
                void logEvent(
                  'auth_state',
                  'keys.set',
                  'error',
                  { category, name },
                  String(ee),
                );
              }
            }
          }
        }
      }
    },
  };

  return {
    state: {
      creds,
      keys,
    },
    saveCreds: () => {
      if (saveTimer) {
        pendingSave = true;
        return;
      }
      saveTimer = setTimeout(flushSave, 500);
    },
    clearCreds: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        pendingSave = false;
      }
      return clear();
    },
  };
};
