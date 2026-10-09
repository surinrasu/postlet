import * as model from "./contracts.js";
import { assert } from "./errors.js";
import { initializeSchema } from "./storage/migrations.js";
import { newId } from "./util.js";

export class Store {
  /** @param {{sql: !PostletSqlStorage, transactionSync: function(function():*):*}} storage */
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    initializeSchema(this);
    this.sql.exec(
      "INSERT OR IGNORE INTO meta(key,value) VALUES('epoch',?)",
      newId("v"),
    );
    this.epoch = this.sql
      .exec("SELECT value FROM meta WHERE key='epoch'")
      .one().value;
  }

  // Callbacks must be synchronous: R2 and other async work is prepared before
  // entering this transaction, with conditional state checked again inside it.
  transaction(callback) {
    return this.storage.transactionSync(callback);
  }
  get(type, id) {
    const rows = this.sql
      .exec("SELECT data FROM objects WHERE type=? AND id=?", type, id)
      .toArray();
    return rows.length ? JSON.parse(String(rows[0].data)) : null;
  }
  all(type) {
    return this.sql
      .exec("SELECT data FROM objects WHERE type=? ORDER BY id", type)
      .toArray()
      .map((row) => JSON.parse(String(row.data)));
  }
  put(type, object) {
    const exists = this.get(type, object.id);
    if (exists && JSON.stringify(exists) === JSON.stringify(object))
      return false;
    this.sql.exec(
      "INSERT INTO objects(type,id,data) VALUES(?,?,?) ON CONFLICT(type,id) DO UPDATE SET data=excluded.data",
      type,
      object.id,
      JSON.stringify(object),
    );
    this.sql.exec(
      "INSERT INTO changes(type,id,kind,created_at) VALUES(?,?,?,?)",
      type,
      object.id,
      exists ? "updated" : "created",
      Date.now(),
    );
    if (type === "Email") this.indexMetadata(object);
    if (type === "Email" || type === "EmailSubmission")
      this.indexBlobReferences(type, object);
    return true;
  }
  destroy(type, id) {
    if (!this.get(type, id)) return false;
    this.sql.exec("DELETE FROM objects WHERE type=? AND id=?", type, id);
    this.sql.exec(
      "INSERT INTO changes(type,id,kind,created_at) VALUES(?,?,'destroyed',?)",
      type,
      id,
      Date.now(),
    );
    if (type === "Email")
      this.sql.exec("DELETE FROM email_index WHERE id=?", id);
    this.releaseBlobReferences(type, id);
    return true;
  }
  state(type) {
    /** @type {{seq: number}} */
    const row = this.sql
      .exec(
        "SELECT coalesce(max(seq),0) AS seq FROM changes WHERE type=?",
        type,
      )
      .one();
    return `${this.epoch}_${type}_${row.seq}`;
  }
  assertState(type, state) {
    assert(state == null || state === this.state(type), "stateMismatch");
  }
  changes(type, sinceState, maxChanges = 256) {
    const prefix = `${this.epoch}_${type}_`;
    assert(
      typeof sinceState === "string" && sinceState.startsWith(prefix),
      "cannotCalculateChanges",
    );
    const suffix = sinceState.slice(prefix.length);
    const seq = Number(suffix);
    assert(
      /^\d+$/.test(suffix) && Number.isSafeInteger(seq) && seq >= 0,
      "cannotCalculateChanges",
    );
    const current = Number(this.state(type).slice(prefix.length));
    const floor = Number(
      this.sql
        .exec("SELECT value FROM meta WHERE key=?", `changes_floor:${type}`)
        .toArray()[0]?.value || 0,
    );
    assert(
      seq <= current &&
        seq >= floor &&
        (seq === floor ||
          this.sql
            .exec("SELECT seq FROM changes WHERE seq=? AND type=?", seq, type)
            .toArray().length > 0),
      "cannotCalculateChanges",
    );
    assert(
      Number.isInteger(maxChanges) && maxChanges > 0 && maxChanges <= 10000,
    );
    const rows = this.sql
      .exec(
        "SELECT seq,id,kind FROM changes WHERE type=? AND seq>? ORDER BY seq LIMIT ?",
        type,
        seq,
        maxChanges + 1,
      )
      .toArray();
    const hasMoreChanges = rows.length > maxChanges;
    if (hasMoreChanges) rows.pop();
    const grouped = new Map();
    for (const row of rows) {
      const existing = grouped.get(row.id);
      grouped.set(row.id, {
        first: existing?.first || row.kind,
        last: row.kind,
      });
    }
    const created = [],
      updated = [],
      destroyed = [];
    for (const [id, value] of grouped) {
      if (value.first === "created" && value.last === "destroyed") continue;
      if (value.last === "destroyed") destroyed.push(id);
      else if (value.first === "created") created.push(id);
      else updated.push(id);
    }
    const result = {
      oldState: sinceState,
      newState: `${prefix}${rows.at(-1)?.seq ?? current}`,
      hasMoreChanges,
      created,
      updated,
      destroyed,
    };
    if (type === "Mailbox") result.updatedProperties = null;
    return result;
  }
  registerBlob(id, size, type) {
    this.sql.exec(
      "INSERT INTO blobs(id,size,type,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at",
      id,
      size,
      type,
      Date.now(),
    );
  }
  /** @param {!model.StoredEmail} email */
  indexMetadata(email) {
    const address = (list) =>
      (list?.[0]?.name || list?.[0]?.email || "").toLowerCase();
    this.sql.exec(
      "INSERT OR REPLACE INTO email_index VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      email.id,
      email.threadId,
      email.receivedAt.toLowerCase(),
      (email.sentAt || "").toLowerCase(),
      email.size,
      (email.subject || "").toLowerCase(),
      address(email.from),
      address(email.to),
      Number(Boolean(email.hasAttachment)),
      // biome-ignore lint/complexity/useLiteralKeys: Keywords are a typed dictionary with arbitrary JMAP keys.
      Number(Boolean(email.keywords?.["$seen"])),
      JSON.stringify(email.keywords || {}),
    );
  }
  releaseBlobReferences(type, id) {
    // The grace period starts when the last owner is removed, not at upload.
    this.sql.exec(
      "UPDATE blobs SET created_at=? WHERE id IN (SELECT blob_id FROM blob_refs WHERE owner_type=? AND owner_id=?)",
      Date.now(),
      type,
      id,
    );
    this.sql.exec(
      "DELETE FROM blob_refs WHERE owner_type=? AND owner_id=?",
      type,
      id,
    );
  }
  indexBlobReferences(type, object) {
    const ids = new Set();
    /** @param {*} value */
    const walk = (value) => {
      if (value === null || typeof value !== "object") return;
      for (const [key, item] of Object.entries(
        /** @type {!Object} */ (value),
      )) {
        if (
          ["blobId", "_blobId", "_bodiesBlobId"].includes(key) &&
          typeof item === "string"
        )
          ids.add(item);
        else if (
          ["dsnBlobIds", "mdnBlobIds"].includes(key) &&
          Array.isArray(item)
        )
          for (const id of item) ids.add(id);
        else if (typeof item === "object") walk(item);
      }
    };
    walk(object);
    this.releaseBlobReferences(type, object.id);
    for (const id of ids)
      this.sql.exec("INSERT INTO blob_refs VALUES(?,?,?)", type, object.id, id);
  }
  pruneChanges(days) {
    const cutoff = Date.now() - days * 86400000;
    return this.transaction(() => {
      let removed = 0;
      /** @type {!Array<{type: string, latest: number}>} */
      const states = this.sql
        .exec("SELECT type,max(seq) AS latest FROM changes GROUP BY type")
        .toArray();
      for (const { type, latest } of states) {
        /** @type {{seq: ?number}} */
        const oldest = this.sql
          .exec(
            "SELECT max(seq) AS seq FROM changes WHERE type=? AND created_at<? AND seq<?",
            type,
            cutoff,
            latest,
          )
          .one();
        const floor = oldest.seq;
        if (floor == null) continue;
        // Delete a contiguous prefix; any older state must trigger a full sync.
        removed += Number(
          this.sql
            .exec(
              "SELECT count(*) AS n FROM changes WHERE type=? AND seq<=?",
              type,
              floor,
            )
            .one().n,
        );
        this.sql.exec(
          "INSERT OR REPLACE INTO meta VALUES(?,?)",
          `changes_floor:${type}`,
          String(floor),
        );
        this.sql.exec(
          "DELETE FROM changes WHERE type=? AND seq<=?",
          type,
          floor,
        );
      }
      return removed;
    });
  }
  blob(id) {
    return (
      this.sql.exec("SELECT * FROM blobs WHERE id=?", id).toArray()[0] ?? null
    );
  }
  /** @param {!model.StoredEmail} email @param {!Object<string, string>=} search */
  indexEmail(email, search) {
    this.sql.exec("DELETE FROM email_mailboxes WHERE email_id=?", email.id);
    for (const mailboxId of Object.keys(email.mailboxIds))
      this.sql.exec(
        "INSERT INTO email_mailboxes VALUES(?,?)",
        email.id,
        mailboxId,
      );
    if (search !== undefined) {
      this.sql.exec("DELETE FROM email_search WHERE email_id=?", email.id);
      // Chunk index rows so no SQLite row approaches the 2 MiB limit.
      for (const [kind, content] of Object.entries(search))
        for (let i = 0; i < content.length; i += 120000)
          this.sql.exec(
            "INSERT INTO email_search(email_id,kind,content) VALUES(?,?,?)",
            email.id,
            kind,
            content.slice(Math.max(0, i - 512), i + 120000),
          );
    }
  }
  searchIds(text, kind = "all") {
    assert(
      typeof text === "string" && text.length <= 256,
      "unsupportedFilter",
      "Search terms must be at most 256 characters.",
    );
    /** @type {!Array<{email_id: string}>} */
    const rows =
      [...text].length >= 3
        ? this.sql
            .exec(
              "SELECT DISTINCT email_id FROM email_search WHERE kind=? AND content MATCH ?",
              kind,
              `"${text.replaceAll('"', '""')}"`,
            )
            .toArray()
        : this.sql
            .exec(
              "SELECT DISTINCT email_id FROM email_search WHERE kind=? AND instr(lower(content),lower(?))>0",
              kind,
              text,
            )
            .toArray();
    return new Set(rows.map((row) => row.email_id));
  }
}
