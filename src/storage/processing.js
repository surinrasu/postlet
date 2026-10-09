// SQL for processing queues lives here; the DO owns alarms and operation gates.
export class ProcessingStore {
  /** @param {{sql: !PostletSqlStorage}} store */
  constructor(store) {
    this.store = store;
  }

  nextTimestamp(query) {
    /** @type {{due: ?number}} */
    const row = this.store.sql.exec(query).one();
    return row.due;
  }

  nextWakeupAt(now = Date.now()) {
    const pending = this.nextTimestamp(
      "SELECT min(next_attempt_at) AS due FROM ingest WHERE status='pending'",
    );
    const processing = this.nextTimestamp(
      "SELECT min(lease_until) AS due FROM ingest WHERE status='processing'",
    );
    const ready = this.nextTimestamp(
      "SELECT min(due) AS due FROM outbox WHERE status='ready'",
    );
    const sending = this.nextTimestamp(
      "SELECT min(attempt_at) AS due FROM outbox WHERE status='sending'",
    );
    const dates = [
      pending == null ? null : Math.max(now + 1000, Number(pending)),
      processing == null ? null : Math.max(now + 1000, Number(processing)),
      ready == null ? null : Math.max(now + 1000, Number(ready)),
      sending == null ? null : Number(sending) + 6 * 60 * 1000,
    ].filter((date) => date !== null);
    return dates.length ? Math.min(...dates) : null;
  }

  status() {
    const now = Date.now();
    /** @type {{oldest: ?number, n: number}} */
    const pending = this.store.sql
      .exec(
        "SELECT min(created_at) AS oldest,count(*) AS n FROM ingest WHERE status IN ('pending','processing')",
      )
      .one();
    const failed = this.store.sql
      .exec("SELECT count(*) AS n FROM ingest WHERE status='failed'")
      .one().n;
    const uncertain = this.store.sql
      .exec("SELECT count(*) AS n FROM outbox WHERE status='unknown'")
      .one().n;
    return {
      metrics: {
        pendingInbound: Number(pending.n),
        oldestPendingMs:
          pending.oldest == null
            ? 0
            : Math.max(0, now - Number(pending.oldest)),
        failedInbound: Number(failed),
        uncertainOutbound: Number(uncertain),
      },
      inbound: this.store.sql
        .exec("SELECT status,count(*) AS count FROM ingest GROUP BY status")
        .toArray(),
      outbound: this.store.sql
        .exec("SELECT status,count(*) AS count FROM outbox GROUP BY status")
        .toArray(),
      failedInbound: this.store.sql
        .exec(
          "SELECT id,blob_id AS blobId,error FROM ingest WHERE status='failed' ORDER BY created_at DESC LIMIT 50",
        )
        .toArray(),
      uncertainOutbound: this.store.sql
        .exec(
          "SELECT id,error FROM outbox WHERE status='unknown' ORDER BY due DESC LIMIT 50",
        )
        .toArray(),
    };
  }
}
