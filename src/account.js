import { DurableObject } from "cloudflare:workers";
import { TYPES } from "./config.js";
import * as model from "./contracts.js";
import { assert } from "./errors.js";
import { Inbound } from "./inbound.js";
import { dispatch } from "./jmap.js";
import { MailService } from "./mail.js";
import { logEvent, withRequestId } from "./observability.js";
import { Outbox } from "./outbox.js";
import { ProcessingStore } from "./storage/processing.js";
import { retentionDays, StorageMaintenance } from "./storage-maintenance.js";
import { Store } from "./store.js";
import { encoder } from "./util.js";

export class MailAccount extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage);
    this.processing = new ProcessingStore(this.store);
    this.mail = new MailService(this.store, env);
    this.mail.initialize();
    this.outbox = new Outbox(this.store, env);
    this.listeners = new Set();
    this.inbound = new Inbound(this.store, this.mail, env);
    this.storageMaintenance = new StorageMaintenance(this.store, env);
    this.activeOperations = 0;
    this.collection = null;
  }

  /** @template T @param {function(): (T|!Promise<T>)} callback @returns {Promise<T>} */
  async withMailOperation(callback) {
    while (this.collection) {
      try {
        await this.collection;
      } catch {
        /* The collection caller reports its error. */
      }
    }
    this.activeOperations++;
    try {
      return await callback();
    } finally {
      this.activeOperations--;
    }
  }

  async collectStorage(apply = false) {
    if (this.collection || this.activeOperations)
      return { applied: false, deferred: "mailboxBusy" };
    this.collection = this.storageMaintenance.collect(apply);
    try {
      return await this.collection;
    } finally {
      this.collection = null;
    }
  }

  /** @param {!Object<string, *>} input @param {!model.AuthContext} auth */
  async execute(input, auth) {
    return withRequestId(auth.requestId || crypto.randomUUID(), () =>
      this.withMailOperation(async () => {
        try {
          const result = await dispatch(this.mail, this.outbox, input, auth);
          // RPC serialization only accepts ordinary JSON objects. Internally we use
          // null-prototype dictionaries for user-supplied creation ids.
          return JSON.parse(JSON.stringify(result));
        } finally {
          this.publish();
          await this.schedule();
        }
      }),
    );
  }

  /** @param {Uint8Array} bytes @param {string} type */
  async upload(bytes, type) {
    return this.withMailOperation(async () => ({
      blobId: await this.mail.putBlob(bytes, type),
      size: bytes.byteLength,
      type,
    }));
  }
  async blobInfo(id) {
    return this.withMailOperation(() => {
      const blob = this.store.blob(id);
      if (blob)
        this.store.sql.exec(
          "UPDATE blobs SET created_at=? WHERE id=?",
          Date.now(),
          id,
        );
      return blob;
    });
  }

  /** @param {!model.InboundTicket} ticket */
  async enqueueIncoming(ticket) {
    return this.withMailOperation(async () => {
      await this.inbound.enqueue(ticket);
      await this.schedule();
    });
  }

  /** @param {!Array<string>} ids */
  async retryIncoming(ids) {
    return this.withMailOperation(async () => {
      const result = this.inbound.retry(ids);
      await this.schedule();
      return result;
    });
  }

  async processIncoming() {
    return this.withMailOperation(() => this.inbound.process());
  }

  async schedule() {
    const due = this.processing.nextWakeupAt();
    if (due === null) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || due < existing)
      await this.ctx.storage.setAlarm(due);
  }

  async alarm() {
    try {
      await this.processIncoming();
      await this.withMailOperation(() => this.outbox.process());
    } finally {
      this.publish();
      await this.schedule();
    }
  }

  async maintenance() {
    // Recover receipts durably written to R2 before an interrupted DO call.
    let cursor =
      this.store.sql
        .exec("SELECT value FROM meta WHERE key='incoming_cursor'")
        .toArray()[0]?.value || undefined;
    for (let page = 0; page < 2; page++) {
      const objects = await this.env.MAIL.list({
        prefix: "incoming/",
        limit: 100,
        cursor: cursor == null ? undefined : String(cursor),
      });
      for (const object of objects.objects) {
        const ticketObject = await this.env.MAIL.get(object.key);
        if (ticketObject) await this.enqueueIncoming(await ticketObject.json());
      }
      cursor = objects.truncated ? objects.cursor : undefined;
      this.store.sql.exec(
        "INSERT OR REPLACE INTO meta VALUES('incoming_cursor',?)",
        cursor || "",
      );
      if (!objects.truncated) break;
    }
    this.store.sql.exec(
      "DELETE FROM query_snapshots WHERE created_at<?",
      Date.now() - 7 * 86400000,
    );
    this.store.sql.exec(
      "DELETE FROM query_snapshots WHERE id NOT IN (SELECT id FROM query_snapshots ORDER BY created_at DESC LIMIT 256)",
    );
    const removedChanges = this.store.pruneChanges(
      retentionDays(this.env.HISTORY_RETENTION_DAYS, 90),
    );
    this.outbox.recover();
    await this.processIncoming();
    this.publish();
    await this.schedule();
    if (this.env.BLOB_GC_ENABLED === "true") await this.collectStorage(true);
    const status = this.status();
    logEvent("mailbox_maintenance", { removedChanges, ...status.metrics });
  }

  status() {
    return {
      ...this.processing.status(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
      sendEnabled: this.env.SEND_ENABLED === "true",
    };
  }

  states(types = TYPES) {
    return Object.fromEntries(
      types.map((type) => [type, this.store.state(type)]),
    );
  }

  events(types, closeAfter, ping) {
    const selected = types === "*" || !types ? TYPES : types.split(",");
    assert(
      selected.every((type) => TYPES.includes(type)) && selected.length > 0,
    );
    assert(closeAfter === "state" || closeAfter === "no" || !closeAfter);
    assert(!ping || (Number.isInteger(Number(ping)) && Number(ping) >= 0));
    let listener;
    const stream = new ReadableStream({
      start: (controller) => {
        const close = () => {
          clearTimeout(listener.timeout);
          clearInterval(listener.heartbeat);
          this.listeners.delete(listener);
          try {
            controller.close();
          } catch {
            /* already canceled */
          }
        };
        listener = { controller, types: selected, closeAfter, close, last: "" };
        listener.timeout = setTimeout(close, 55000);
        listener.heartbeat = setInterval(
          () => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              close();
            }
          },
          Math.max(1000, Math.min(Number(ping || 30), 30) * 1000),
        );
        this.listeners.add(listener);
        this.publish();
      },
      cancel: () => listener?.close(),
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  publish() {
    for (const listener of this.listeners) {
      const state = JSON.stringify(this.states(listener.types));
      if (state === listener.last) continue;
      listener.last = state;
      const data = {
        "@type": "StateChange",
        changed: { [this.mail.accountId]: JSON.parse(state) },
      };
      try {
        listener.controller.enqueue(
          encoder.encode(`event: state\ndata: ${JSON.stringify(data)}\n\n`),
        );
      } catch {
        listener.close();
      }
      if (listener.closeAfter === "state") listener.close();
    }
  }
}
