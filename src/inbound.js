import * as model from "./contracts.js";
import { assert, JmapError } from "./errors.js";
import { logEvent } from "./observability.js";
import { newId, validId } from "./util.js";

const LEASE_MS = 5 * 60 * 1000;

/** @param {number} attempts */
export function retryDelay(attempts) {
  const base = Math.min(6 * 3600000, 30000 * 2 ** Math.min(attempts - 1, 10));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class Inbound {
  constructor(store, mail, env) {
    this.store = store;
    this.mail = mail;
    this.env = env;
  }

  /** @param {!model.InboundTicket} ticket */
  async enqueue(ticket) {
    assert(validId(ticket.id) && validId(ticket.blobId));
    // New ingress uses a separate R2 namespace, outside mailbox blob GC.
    assert(!ticket.rawKey || ticket.rawKey === `incoming-raw/${ticket.id}`);
    if (this.received(ticket.id)) {
      this.store.sql.exec(
        "UPDATE ingest SET status='complete',error=NULL,lease_id=NULL,lease_until=NULL WHERE id=?",
        ticket.id,
      );
      await this.cleanup(ticket.id, ticket.rawKey);
      return;
    }
    this.store.transaction(() => {
      if (!ticket.rawKey)
        this.store.registerBlob(ticket.blobId, ticket.size, "message/rfc822");
      this.store.sql.exec(
        "INSERT OR IGNORE INTO ingest(id,blob_id,envelope,status,created_at,raw_key) VALUES(?,?,?,'pending',?,?)",
        ticket.id,
        ticket.blobId,
        JSON.stringify(ticket.envelope),
        ticket.createdAt,
        ticket.rawKey || null,
      );
    });
  }

  received(id) {
    return (
      this.store.sql.exec("SELECT id FROM receipts WHERE id=?", id).toArray()
        .length > 0
    );
  }

  async cleanup(id, rawKey) {
    // Remove the ticket last so cleanup can be retried by maintenance.
    if (rawKey) await this.env.MAIL.delete(rawKey);
    await this.env.MAIL.delete(`incoming/${id}`);
  }

  /** @param {!Array<string>} ids */
  retry(ids) {
    assert(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 100 &&
        ids.every(validId),
    );
    const retried = [],
      notRetried = [];
    this.store.transaction(() => {
      for (const id of new Set(ids)) {
        const rows = this.store.sql
          .exec(
            "UPDATE ingest SET status='pending',attempts=0,error=NULL,next_attempt_at=0 WHERE id=? AND status IN ('failed','pending') RETURNING id",
            id,
          )
          .toArray();
        (rows.length ? retried : notRetried).push(id);
      }
    });
    logEvent("inbound_requeued", { count: retried.length });
    return { retried, notRetried };
  }

  async process() {
    this.store.sql.exec(
      "UPDATE ingest SET status='pending',lease_id=NULL,lease_until=NULL WHERE status='processing' AND lease_until<=?",
      Date.now(),
    );
    const pending = this.store.sql
      .exec(
        "SELECT * FROM ingest WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT 5",
        Date.now(),
      )
      .toArray();
    for (const item of pending) {
      const lease = newId("lease");
      const claimed = this.store.sql
        .exec(
          "UPDATE ingest SET status='processing',lease_id=?,lease_until=? WHERE id=? AND status='pending' RETURNING id",
          lease,
          Date.now() + LEASE_MS,
          item.id,
        )
        .toArray();
      if (!claimed.length) continue;
      // Persist a wakeup before R2 I/O, including if this invocation is lost.
      const alarm = await this.store.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + LEASE_MS)
        await this.store.storage.setAlarm(Date.now() + LEASE_MS);
      let stage = "load_raw";
      try {
        if (!this.received(item.id)) {
          const object = await this.env.MAIL.get(
            String(item.raw_key || `blobs/${item.blob_id}`),
          );
          if (!object)
            throw new JmapError("serverFail", "Missing inbound raw message.");
          stage = "parse";
          const prepared = await this.mail.prepareEmail(
            new Uint8Array(await object.arrayBuffer()),
            {
              mailboxIds: { m_inbox: true },
              receivedAt: new Date(Number(item.created_at)).toISOString(),
            },
          );
          stage = "commit";
          this.store.transaction(() => {
            const owned = this.store.sql
              .exec(
                "SELECT id FROM ingest WHERE id=? AND lease_id=?",
                item.id,
                lease,
              )
              .toArray().length;
            if (!owned || this.received(item.id)) return;
            const result = this.mail.insertPrepared(prepared);
            this.store.sql.exec(
              "INSERT INTO receipts VALUES(?,?)",
              item.id,
              result.id,
            );
          });
        }
        if (!this.received(item.id)) continue;
        this.store.sql.exec(
          "UPDATE ingest SET status='complete',error=NULL,lease_id=NULL,lease_until=NULL WHERE id=?",
          item.id,
        );
        stage = "cleanup";
        await this.cleanup(item.id, item.raw_key);
      } catch (error) {
        const permanent =
          error instanceof JmapError &&
          ["invalidEmail", "tooLarge"].includes(error.type);
        const delay = retryDelay(Number(item.attempts) + 1);
        // Cleanup errors cannot turn a committed delivery back into a failure.
        this.store.sql.exec(
          "UPDATE ingest SET status=?,attempts=attempts+1,error=?,next_attempt_at=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?",
          permanent ? "failed" : "pending",
          permanent ? error.type : "processingFailed",
          Date.now() + delay,
          item.id,
          lease,
        );
        logEvent(
          "inbound_processing_failed",
          {
            receiptId: String(item.id),
            stage,
            permanent,
            attempt: Number(item.attempts) + 1,
            retryInMs: permanent ? null : delay,
          },
          error,
        );
      }
    }
  }
}
