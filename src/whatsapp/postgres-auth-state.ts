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
  const read = async (key: string): Promise<unknown | null> => {
    const rows = await sql<{ value: string }[]>`
      SELECT value FROM auth_state WHERE key = ${key} LIMIT 1
    `;
    if (rows.length > 0 && rows[0]?.value) {
      return JSON.parse(rows[0].value, BufferJSON.reviver as never);
    }
    return null;
  };

  const write = async (key: string, value: unknown): Promise<void> => {
    const serialized = JSON.stringify(value, BufferJSON.replacer as never);
    await sql`
      INSERT INTO auth_state (key, value) VALUES (${key}, ${serialized})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
    `;
  };

  const remove = async (key: string): Promise<void> => {
    await sql`DELETE FROM auth_state WHERE key = ${key}`;
  };

  const clear = async (): Promise<void> => {
    await sql`DELETE FROM auth_state`;
  };

  const creds: AuthenticationCreds =
    ((await read('creds')) as AuthenticationCreds) ?? initAuthCreds();

  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
      for (const id of ids) {
        let value = await read(`${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.create(value as never);
        }
        data[id] = value as never;
      }
      return data;
    },
    set: async (data: SignalDataSet) => {
      for (const category in data) {
        for (const id in data[category as keyof SignalDataTypeMap]) {
          const value = data[category as keyof SignalDataTypeMap]?.[id];
          const name = `${category}-${id}`;
          if (value) {
            await write(name, value);
          } else {
            await remove(name);
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
      return write('creds', creds);
    },
    clearCreds: () => {
      return clear();
    },
  };
};
