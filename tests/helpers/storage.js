import { Database } from "bun:sqlite";

export function sqliteStorage() {
  const db = new Database(":memory:");
  let alarm = null;
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const rows = db.query(query).all(...bindings);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error("Expected one row");
            return rows[0];
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
      databaseSize: 0,
    },
    transactionSync: (fn) => db.transaction(fn)(),
    getAlarm: async () => alarm,
    setAlarm: async (value) => {
      alarm = value;
    },
  };
  return { db, storage };
}

export function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options = {}) {
      const bytes =
        typeof value === "string" ? new TextEncoder().encode(value) : value;
      objects.set(key, {
        bytes,
        uploaded: new Date(),
        httpMetadata: options.httpMetadata,
      });
    },
    async get(key) {
      const object = objects.get(key);
      return object
        ? {
            size: object.bytes.byteLength,
            arrayBuffer: async () => object.bytes,
            json: async () =>
              JSON.parse(new TextDecoder().decode(object.bytes)),
          }
        : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix, limit = 1000, cursor = "" }) {
      const matches = [...objects]
        .filter(([key]) => key.startsWith(prefix) && key > cursor)
        .sort(([a], [b]) => a.localeCompare(b));
      const page = matches.slice(0, limit).map(([key, value]) => ({
        key,
        size: value.bytes.byteLength,
        uploaded: value.uploaded,
      }));
      return {
        objects: page,
        truncated: matches.length > limit,
        cursor: page.at(-1)?.key,
      };
    },
  };
}
