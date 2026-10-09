import { performance } from "node:perf_hooks";
import { MailService } from "../src/mail.js";
import { matchingObjects, query } from "../src/query.js";
import { Store } from "../src/store.js";
import { sqliteStorage } from "../tests/helpers/storage.js";

const count = Number(process.argv[2] || 10000);
if (!Number.isInteger(count) || count < 1000 || count > 100000)
  throw new Error("Use a message count between 1000 and 100000");
const { db, storage } = sqliteStorage();
try {
  const store = new Store(storage);
  const mail = new MailService(store, {
    MAIL_DOMAIN: "example.test",
    MAIL_ADDRESS: "root@example.test",
  });
  mail.initialize();
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const email = {
        id: `e${String(i).padStart(6, "0")}`,
        threadId: `t${i % 1000}`,
        receivedAt: new Date(1700000000000 + i * 1000).toISOString(),
        sentAt: null,
        size: 1000,
        subject: `Message ${i}`,
        keywords: i % 2 ? { $seen: true } : {},
        mailboxIds: { m_inbox: true },
        hasAttachment: false,
        headers: [],
        preview: "mailbox benchmark ".repeat(30),
      };
      store.put("Email", email);
      store.indexEmail(email);
    }
    mail.refresh(["m_inbox"], []);
  });
  const args = {
    filter: { inMailbox: "m_inbox" },
    limit: 30,
    calculateTotal: true,
  };
  const timings = {};
  for (const [name, run] of [
    ["indexed_query", () => query(store, "Email", args)],
    ["metadata_scan_baseline", () => matchingObjects(store, "Email", args)],
    [
      "thread_keyword_filter",
      () =>
        matchingObjects(store, "Email", {
          filter: { someInThreadHaveKeyword: "$seen" },
        }),
    ],
    [
      "mark_100_read",
      () =>
        mail.emailSet(
          {
            update: Object.fromEntries(
              Array.from({ length: 100 }, (_, i) => [
                `e${String(i).padStart(6, "0")}`,
                { "keywords/$seen": true },
              ]),
            ),
          },
          {},
        ),
    ],
  ]) {
    const samples = [];
    for (let i = 0; i < 6; i++) {
      if (name === "mark_100_read")
        await mail.emailSet(
          {
            update: Object.fromEntries(
              Array.from({ length: 100 }, (_, n) => [
                `e${String(n).padStart(6, "0")}`,
                { "keywords/$seen": null },
              ]),
            ),
          },
          {},
        );
      const start = performance.now();
      await run();
      if (i > 0) samples.push(performance.now() - start);
    }
    timings[name] = Number(samples.sort((a, b) => a - b)[2].toFixed(2));
  }
  console.log(
    JSON.stringify(
      {
        messages: count,
        runtime: "Bun SQLite, in-memory; not Cloudflare latency",
        medianMs: timings,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
