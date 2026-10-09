import { logEvent } from "./observability.js";

/** @param {string | undefined} value @param {number} fallback */
export function retentionDays(value, fallback) {
  const days = Number(value ?? fallback);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : fallback;
}

export class StorageMaintenance {
  constructor(store, env) {
    this.store = store;
    this.env = env;
  }

  // Called only while the account's mailbox operations are idle and gated.
  async collect(apply = false) {
    const days = retentionDays(this.env.BLOB_RETENTION_DAYS, 30);
    const cutoff = Date.now() - days * 86400000;
    // Protect receipts from the old ingress layout, including tickets whose DO
    // enqueue was interrupted. New ingress never writes the mailbox namespace.
    const incoming = await this.env.MAIL.list({
      prefix: "incoming/",
      limit: 100,
    });
    if (incoming.truncated)
      return {
        applied: false,
        deferred: "incomingBacklog",
        retentionDays: days,
      };
    const protectedIds = new Set();
    for (const object of incoming.objects) {
      const ticketObject = await this.env.MAIL.get(object.key);
      if (!ticketObject) continue;
      const ticket = await ticketObject.json();
      if (!ticket.rawKey) protectedIds.add(ticket.blobId);
    }
    const previous = this.store.sql
      .exec("SELECT value FROM meta WHERE key='blob_scan_cursor'")
      .toArray()[0]?.value;
    const page = await this.env.MAIL.list({
      prefix: "blobs/",
      limit: 100,
      ...(previous ? { cursor: String(previous) } : {}),
    });
    for (const object of page.objects) {
      // Recover blobs written just before an interrupted metadata commit.
      this.store.sql.exec(
        "INSERT OR IGNORE INTO blobs VALUES(?,?,?,?)",
        object.key.slice(6),
        object.size,
        "application/octet-stream",
        object.uploaded.getTime(),
      );
    }
    this.store.sql.exec(
      "INSERT OR REPLACE INTO meta VALUES('blob_scan_cursor',?)",
      page.truncated ? page.cursor : "",
    );
    const eligible = `FROM blobs b WHERE b.created_at<? AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.blob_id=b.id) AND NOT EXISTS (SELECT 1 FROM ingest i WHERE i.blob_id=b.id AND i.status!='complete')`;
    const candidates = this.store.sql
      .exec(
        `SELECT b.id,b.size ${eligible} ORDER BY b.created_at,b.id LIMIT 100`,
        cutoff,
      )
      .toArray()
      .filter((b) => !protectedIds.has(b.id));
    let deleted = 0;
    if (apply)
      for (const blob of candidates) {
        await this.env.MAIL.delete(`blobs/${blob.id}`);
        this.store.sql.exec("DELETE FROM blobs WHERE id=?", blob.id);
        deleted++;
      }
    const result = {
      applied: apply,
      retentionDays: days,
      scanned: page.objects.length,
      scanHasMore: page.truncated,
      candidates,
      candidateBytes: candidates.reduce((n, b) => n + Number(b.size), 0),
      deleted,
    };
    logEvent("blob_collection", {
      applied: apply,
      candidates: candidates.length,
      candidateBytes: result.candidateBytes,
      deleted,
    });
    return result;
  }
}
