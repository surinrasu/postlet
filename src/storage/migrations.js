import { assert } from "../errors.js";

// Versions are mailbox SQLite schemas, independent of Wrangler DO migrations.
const SCHEMA_VERSION = 2;
const BASE_SCHEMA = `
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_type_seq ON changes(type,seq);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest (id TEXT PRIMARY KEY, blob_id TEXT NOT NULL, envelope TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, status TEXT NOT NULL, due INTEGER NOT NULL, attempt_at INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, email_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_mailboxes (email_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, PRIMARY KEY(email_id,mailbox_id));
      CREATE INDEX IF NOT EXISTS memberships_mailbox ON email_mailboxes(mailbox_id,email_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS email_search USING fts5(email_id UNINDEXED, kind UNINDEXED, content, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS query_snapshots (id TEXT PRIMARY KEY, type TEXT NOT NULL, signature TEXT NOT NULL, ids TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_index (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, received_at TEXT NOT NULL, sent_at TEXT NOT NULL, size INTEGER NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, has_attachment INTEGER NOT NULL, seen INTEGER NOT NULL, keywords TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS emails_received ON email_index(received_at DESC,id);
      CREATE INDEX IF NOT EXISTS emails_thread ON email_index(thread_id,received_at,id);
      CREATE TABLE IF NOT EXISTS blob_refs (owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, blob_id TEXT NOT NULL, PRIMARY KEY(owner_type,owner_id,blob_id));
      CREATE INDEX IF NOT EXISTS refs_blob ON blob_refs(blob_id);
    `;

function migrateToV2(store) {
  const columns = new Set(
    store.sql
      .exec("PRAGMA table_info(ingest)")
      .toArray()
      .map((c) => c.name),
  );
  for (const [name, definition] of Object.entries({
    next_attempt_at: "INTEGER NOT NULL DEFAULT 0",
    lease_id: "TEXT",
    lease_until: "INTEGER",
    raw_key: "TEXT",
  }))
    if (!columns.has(name))
      store.sql.exec(`ALTER TABLE ingest ADD COLUMN ${name} ${definition}`);
  const changes = store.sql.exec("PRAGMA table_info(changes)").toArray();
  if (!changes.some((c) => c.name === "created_at")) {
    store.sql.exec(
      "ALTER TABLE changes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
    );
    store.sql.exec("UPDATE changes SET created_at=?", Date.now());
  }
  // Old releases exhausted transient retries; allow those receipts to recover.
  store.sql.exec(
    "UPDATE ingest SET status='pending',next_attempt_at=0 WHERE status='failed' AND error='processingFailed'",
  );
  for (const row of store.sql.exec(
    "SELECT type,data FROM objects WHERE type IN ('Email','EmailSubmission')",
  )) {
    const object = JSON.parse(String(row.data));
    if (row.type === "Email") store.indexMetadata(object);
    store.indexBlobReferences(row.type, object);
  }
}

const migrations = [{ version: 2, apply: migrateToV2 }];

export function initializeSchema(store) {
  for (const statement of BASE_SCHEMA.split(";")) {
    if (statement.trim()) store.sql.exec(statement);
  }
  store.transaction(() => {
    const value = store.sql
      .exec("SELECT value FROM meta WHERE key='schema_version'")
      .toArray()[0]?.value;
    const version = Number(value || 0);
    assert(
      version <= SCHEMA_VERSION,
      "serverFail",
      "Database schema is newer than this release.",
    );
    for (const migration of migrations) {
      if (version >= migration.version) continue;
      migration.apply(store);
      store.sql.exec(
        "INSERT OR REPLACE INTO meta VALUES('schema_version',?)",
        String(migration.version),
      );
    }
  });
  store.sql.exec(
    "CREATE INDEX IF NOT EXISTS ingest_due ON ingest(status,next_attempt_at,created_at)",
  );
  store.sql.exec("CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,due)");
  store.sql.exec(
    "CREATE INDEX IF NOT EXISTS changes_age ON changes(created_at)",
  );
}
