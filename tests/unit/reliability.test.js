import { afterEach, expect, test } from "bun:test";
import { Inbound } from "../../src/inbound.js";
import { MailService } from "../../src/mail.js";
import {
  errorFields,
  logEvent,
  withRequestId,
} from "../../src/observability.js";
import { matchingObjects, query, queryChanges } from "../../src/query.js";
import { StorageMaintenance } from "../../src/storage-maintenance.js";
import { Store } from "../../src/store.js";
import { memoryBucket, sqliteStorage } from "../helpers/storage.js";

const databases = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function harness() {
  const { db, storage } = sqliteStorage();
  databases.push(db);
  const env = {
    MAIL: memoryBucket(),
    MAIL_DOMAIN: "example.test",
    MAIL_ADDRESS: "root@example.test",
    SEND_ENABLED: "false",
  };
  const store = new Store(storage),
    mail = new MailService(store, env);
  mail.initialize();
  return {
    db,
    storage,
    env,
    store,
    mail,
    inbound: new Inbound(store, mail, env),
    gc: new StorageMaintenance(store, env),
  };
}
const raw = new TextEncoder().encode(
  "From: sender@example.com\r\nTo: root@example.test\r\nSubject: Recovery\r\n\r\nHello",
);
const ticket = (id) => ({
  id,
  blobId: `b_${id}`,
  rawKey: `incoming-raw/${id}`,
  size: raw.length,
  createdAt: Date.now(),
  envelope: { from: "sender@example.com", to: "root@example.test" },
});

test("transient inbound failures remain retryable beyond five attempts and recover exactly once", async () => {
  const h = harness(),
    t = ticket("recover");
  await h.env.MAIL.put(`incoming/${t.id}`, JSON.stringify(t));
  await h.inbound.enqueue(t);
  for (let i = 0; i < 6; i++) {
    h.store.sql.exec("UPDATE ingest SET next_attempt_at=0");
    await h.inbound.process();
    const row = h.store.sql.exec("SELECT * FROM ingest").one();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(i + 1);
    expect(row.next_attempt_at).toBeGreaterThan(Date.now() + 20000);
    await h.inbound.process();
    expect(h.store.sql.exec("SELECT attempts FROM ingest").one().attempts).toBe(
      i + 1,
    );
  }
  await h.env.MAIL.put(t.rawKey, raw);
  h.store.sql.exec("UPDATE ingest SET next_attempt_at=0");
  await Promise.all([h.inbound.process(), h.inbound.process()]);
  await h.inbound.enqueue(t);
  expect(h.store.all("Email")).toHaveLength(1);
  expect(h.store.sql.exec("SELECT status FROM ingest").one().status).toBe(
    "complete",
  );
  expect(await h.env.MAIL.get(t.rawKey)).toBeNull();
});

test("permanent failures require explicit retry and an interrupted lease can be reclaimed", async () => {
  const h = harness(),
    t = ticket("permanent");
  h.env.MAX_MESSAGE_BYTES = "1";
  await h.env.MAIL.put(t.rawKey, raw);
  await h.inbound.enqueue(t);
  await h.inbound.process();
  expect(h.store.sql.exec("SELECT status,error FROM ingest").one()).toEqual({
    status: "failed",
    error: "tooLarge",
  });
  h.env.MAX_MESSAGE_BYTES = "10485760";
  expect(h.inbound.retry([t.id, "missing"])).toEqual({
    retried: [t.id],
    notRetried: ["missing"],
  });
  h.store.sql.exec(
    "UPDATE ingest SET status='processing',lease_id='dead',lease_until=0",
  );
  await h.inbound.process();
  expect(h.store.all("Email")).toHaveLength(1);
});

test("ticket cleanup failure never undoes a committed delivery", async () => {
  const h = harness(),
    t = ticket("cleanup");
  await h.env.MAIL.put(t.rawKey, raw);
  await h.inbound.enqueue(t);
  const remove = h.env.MAIL.delete;
  h.env.MAIL.delete = async () => {
    throw new Error("temporary delete failure");
  };
  await h.inbound.process();
  expect(h.store.sql.exec("SELECT status FROM ingest").one().status).toBe(
    "complete",
  );
  h.env.MAIL.delete = remove;
  await h.inbound.enqueue(t);
  expect(h.store.all("Email")).toHaveLength(1);
  expect(await h.env.MAIL.get(t.rawKey)).toBeNull();
});

test("blob collection previews, honors references and release grace, and protects legacy tickets", async () => {
  const h = harness();
  const prepared = await h.mail.prepareEmail(raw, {
    mailboxIds: { m_inbox: true },
  });
  const email = h.store.transaction(() => h.mail.insertPrepared(prepared));
  const old = Date.now() - 40 * 86400000;
  for (const id of ["orphan", "fresh", "queued", "legacy", "failed"]) {
    await h.env.MAIL.put(`blobs/${id}`, new Uint8Array([1, 2]));
    h.store.registerBlob(id, 2, "text/plain");
  }
  h.store.put("EmailSubmission", { id: "s_queued", _blobId: "queued" });
  h.store.sql.exec("UPDATE blobs SET created_at=? WHERE id!='fresh'", old);
  await h.env.MAIL.put("incoming/legacy", JSON.stringify({ blobId: "legacy" }));
  h.store.sql.exec(
    "INSERT INTO ingest(id,blob_id,envelope,status,created_at) VALUES('f','failed','{}','failed',?)",
    old,
  );
  const preview = await h.gc.collect();
  expect(preview.candidates.map((b) => b.id)).toEqual(["orphan"]);
  expect(await h.env.MAIL.get("blobs/orphan")).not.toBeNull();
  const applied = await h.gc.collect(true);
  expect(applied.deleted).toBe(1);
  expect(await h.env.MAIL.get(`blobs/${email.blobId}`)).not.toBeNull();
  h.store.transaction(() => h.mail.destroyEmail(email.id));
  expect((await h.gc.collect()).candidates).toHaveLength(0);
  h.store.sql.exec(
    "UPDATE blobs SET created_at=? WHERE id=?",
    old,
    email.blobId,
  );
  expect((await h.gc.collect()).candidates.map((b) => b.id)).toContain(
    email.blobId,
  );
  await h.mail.putBlob(raw, "message/rfc822");
  expect((await h.gc.collect()).candidates.map((b) => b.id)).not.toContain(
    email.blobId,
  );
});

test("pruning change history preserves current state and rejects expired sync tokens", () => {
  const h = harness(),
    initial = h.store.state("Identity");
  h.store.put("Identity", { id: "extra", name: "one" });
  const boundary = h.store.state("Identity");
  h.store.sql.exec("UPDATE changes SET created_at=0");
  h.store.put("Identity", { id: "extra", name: "two" });
  const current = h.store.state("Identity");
  expect(h.store.pruneChanges(90)).toBeGreaterThan(0);
  expect(h.store.state("Identity")).toBe(current);
  expect(() => h.store.changes("Identity", initial)).toThrow(
    "cannotCalculateChanges",
  );
  expect(h.store.changes("Identity", boundary).updated).toEqual(["extra"]);
  expect(h.store.changes("Identity", current).updated).toEqual([]);
});

test("legacy database migration backfills indexes and references without changing sync states", () => {
  const { db, storage } = sqliteStorage();
  databases.push(db);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('epoch','v_legacy');
    CREATE TABLE objects (type TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(type,id));
    CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL);
    INSERT INTO changes(type,id,kind) VALUES('Email','e_old','created');
    CREATE TABLE ingest (id TEXT PRIMARY KEY,blob_id TEXT NOT NULL,envelope TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL);
    INSERT INTO ingest VALUES('recover_old','b_old','{}','failed',5,'processingFailed',0);
  `);
  const email = {
    id: "e_old",
    blobId: "b_old",
    _bodiesBlobId: "b_body",
    bodyStructure: { blobId: "b_part" },
    threadId: "t_old",
    receivedAt: "2026-01-01T00:00:00.000Z",
    size: 100,
    keywords: {},
    mailboxIds: { m_inbox: true },
  };
  db.query("INSERT INTO objects VALUES('Email','e_old',?)").run(
    JSON.stringify(email),
  );
  const store = new Store(storage);
  expect(store.state("Email")).toBe("v_legacy_Email_1");
  expect(store.sql.exec("SELECT id FROM email_index").one().id).toBe("e_old");
  expect(
    store.sql
      .exec("SELECT blob_id FROM blob_refs ORDER BY blob_id")
      .toArray()
      .map((r) => r.blob_id),
  ).toEqual(["b_body", "b_old", "b_part"]);
  expect(store.sql.exec("SELECT status FROM ingest").one().status).toBe(
    "pending",
  );
  expect(new Store(storage).state("Email")).toBe("v_legacy_Email_1");
});

test("large indexed queries return bounded pages without loading mailbox objects", async () => {
  const h = harness();
  h.store.transaction(() => {
    for (let i = 0; i < 20001; i++)
      h.store.indexMetadata({
        id: `e${String(i).padStart(6, "0")}`,
        threadId: "t",
        receivedAt: new Date(1700000000000 + i * 1000).toISOString(),
        size: i,
        keywords: {},
      });
  });
  h.store.all = () => {
    throw new Error("Unexpected metadata scan");
  };
  const result = await query(h.store, "Email", {
    position: -3,
    limit: 2,
    calculateTotal: true,
  });
  expect(result.result).toMatchObject({
    ids: ["e000002", "e000001"],
    total: 20001,
    position: 19998,
    canCalculateChanges: false,
  });
  expect(result.allIds).toBeNull();
  const plan = h.store.sql
    .exec(
      "EXPLAIN QUERY PLAN SELECT id FROM email_index ORDER BY received_at DESC,id LIMIT 30",
    )
    .toArray();
  expect(plan.some((row) => row.detail.includes("emails_received"))).toBe(true);
});

function seed(h, count) {
  h.store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const email = {
        id: `e${String(i).padStart(6, "0")}`,
        threadId: `t${i % 7}`,
        receivedAt: new Date(1700000000000 + i * 1000).toISOString(),
        sentAt: null,
        size: i + 100,
        subject: i % 2 ? "中文 İ ABC" : "other",
        hasAttachment: i % 3 === 0,
        keywords: i % 2 ? { $seen: true } : {},
        mailboxIds: { [i % 3 ? "m_inbox" : "m_archive"]: true },
        headers: [],
        from: [],
        to: [],
      };
      h.store.put("Email", email);
      h.store.indexEmail(email);
    }
  });
}

test("indexed queries match fallback ordering, filters, pagination and queryChanges", async () => {
  const h = harness();
  seed(h, 80);
  for (const filter of [
    null,
    { inMailbox: "m_inbox" },
    { subject: "İ" },
    { hasKeyword: "$seen" },
    {
      operator: "NOT",
      conditions: [{ hasAttachment: true }, { minSize: 160 }],
    },
    { after: new Date(1700000000000 + 20000).toISOString(), maxSize: 150 },
  ]) {
    for (const sort of [
      undefined,
      [{ property: "size", isAscending: true }],
      [{ property: "subject", isAscending: false }],
    ]) {
      const expected = matchingObjects(h.store, "Email", { filter, sort }).map(
        (e) => e.id,
      );
      const actual = await query(h.store, "Email", {
        filter,
        sort,
        position: -5,
        limit: 3,
        calculateTotal: true,
      });
      expect(actual.result.ids).toEqual(
        expected.slice(
          Math.max(0, expected.length - 5),
          Math.max(0, expected.length - 5) + 3,
        ),
      );
      expect(actual.result.total).toBe(expected.length);
    }
  }
  const before = await query(h.store, "Email", {});
  h.store.destroy("Email", "e000010");
  expect(
    (
      await queryChanges(h.store, "Email", {
        sinceQueryState: before.result.queryState,
      })
    ).removed,
  ).toEqual(["e000010"]);
  const original = h.store.all;
  h.store.all = () => {
    throw new Error("Indexed query must not load objects");
  };
  expect((await query(h.store, "Email", { limit: 1 })).result.ids).toHaveLength(
    1,
  );
  h.store.all = original;
});

test("thread keyword filters retain all/some/none semantics", () => {
  const h = harness();
  seed(h, 80);
  const all = h.store.all("Email");
  for (const key of [
    "allInThreadHaveKeyword",
    "someInThreadHaveKeyword",
    "noneInThreadHaveKeyword",
  ]) {
    const expected = all
      .filter((e) => {
        const flags = all
          .filter((x) => x.threadId === e.threadId)
          .map((x) => !!x.keywords.$seen);
        return key.startsWith("all")
          ? flags.every(Boolean)
          : key.startsWith("some")
            ? flags.some(Boolean)
            : !flags.some(Boolean);
      })
      .map((e) => e.id)
      .sort();
    expect(
      matchingObjects(h.store, "Email", { filter: { [key]: "$seen" } })
        .map((e) => e.id)
        .sort(),
    ).toEqual(expected);
  }
});

test("error diagnostics omit sensitive messages and correlate concurrent requests", async () => {
  const error = Object.assign(new Error("secret-token mail-body"), {
    code: "secret-token",
    name: "secret-token",
  });
  expect(errorFields(error)).toEqual({
    errorName: "Error",
    errorCode: "unexpected",
  });
  const lines = [],
    original = console.error;
  console.error = (line) => lines.push(JSON.parse(line));
  try {
    await Promise.all(
      ["first", "second"].map((id) =>
        withRequestId(id, async () => {
          await Promise.resolve();
          logEvent("failure", { stage: "load" }, error);
        }),
      ),
    );
  } finally {
    console.error = original;
  }
  expect(lines.map((line) => line.requestId).sort()).toEqual([
    "first",
    "second",
  ]);
  expect(JSON.stringify(lines)).not.toContain("secret-token");
});
