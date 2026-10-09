// The OAuth library's KV contract backed by the authentication Durable Object.
// All OAuth requests run under blockConcurrencyWhile: codes, refresh rotation,
// consent and revocation observe a single consistent copy rather than edge KV.
export class AuthStorage {
  constructor(sql) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS credential_lineage (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS credential_parent ON credential_lineage(parent_id)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS auth_values (name TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS auth_values_expiry ON auth_values(expires)",
    );
  }
  async get(name, options = {}) {
    const row = this.sql
      .exec(
        "SELECT value FROM auth_values WHERE name=? AND (expires IS NULL OR expires>?)",
        name,
        Date.now(),
      )
      .toArray()[0];
    if (!row) return null;
    const type = typeof options === "string" ? options : options.type;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }
  async put(name, value, options = {}) {
    if (typeof value !== "string")
      throw new TypeError("Authentication storage expects strings");
    const expires = options.expiration
      ? options.expiration * 1000
      : options.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : null;
    this.sql.exec(
      "INSERT INTO auth_values VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,expires=excluded.expires",
      name,
      value,
      expires,
    );
  }
  async delete(name) {
    this.sql.exec("DELETE FROM auth_values WHERE name=?", name);
  }
  /** @param {{prefix: (string|undefined), cursor: (string|undefined), limit: (number|undefined)}=} options */
  async list({ prefix = "", cursor = "", limit = 1000 } = {}) {
    const rows = this.sql
      .exec(
        "SELECT name,expires FROM auth_values WHERE substr(name,1,?)=? AND name>? AND (expires IS NULL OR expires>?) ORDER BY name LIMIT ?",
        prefix.length,
        prefix,
        cursor,
        Date.now(),
        limit + 1,
      )
      .toArray();
    const complete = rows.length <= limit;
    const selected = rows.slice(0, limit);
    return {
      keys: selected.map((r) => ({
        name: r.name,
        ...(r.expires ? { expiration: Math.floor(r.expires / 1000) } : {}),
      })),
      list_complete: complete,
      cursor: complete ? "" : selected.at(-1).name,
    };
  }
  clean() {
    this.sql.exec(
      "DELETE FROM auth_values WHERE expires IS NOT NULL AND expires<=?",
      Date.now(),
    );
  }
}
