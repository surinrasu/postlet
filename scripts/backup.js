import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connect } from "./client.js";

const client = await connect();
const target = resolve(
  process.argv[2] ||
    `.secrets/backup-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(target, { mode: 0o700 });
await mkdir(join(target, "messages"), { mode: 0o700 });
const [before, mailboxes] = await client.jmap([
  ["Email/get", { ids: [] }],
  ["Mailbox/get", {}],
]);
const emails = [];
let position = 0;
while (true) {
  const [page] = await client.jmap([
    [
      "Email/query",
      {
        position,
        limit: 256,
        sort: [{ property: "receivedAt", isAscending: true }],
      },
    ],
  ]);
  if (!page.ids.length) break;
  const [batch] = await client.jmap([
    [
      "Email/get",
      {
        ids: page.ids,
        properties: ["id", "blobId", "mailboxIds", "keywords", "receivedAt"],
      },
    ],
  ]);
  for (const email of batch.list) {
    const response = await fetch(client.downloadUrl(email.blobId), {
      headers: client.headers,
    });
    if (!response.ok)
      throw new Error(`Blob download failed: HTTP ${response.status}`);
    await writeFile(
      join(target, "messages", `${email.id}.eml`),
      new Uint8Array(await response.arrayBuffer()),
      { mode: 0o600, flag: "wx" },
    );
    emails.push(email);
  }
  position += page.ids.length;
}
const [after, afterMailboxes] = await client.jmap([
  ["Email/get", { ids: [] }],
  ["Mailbox/get", { ids: [] }],
]);
if (before.state !== after.state || mailboxes.state !== afterMailboxes.state)
  throw new Error(
    `Mailbox changed during backup. Partial files remain in ${target}; rerun into a new directory for a consistent manifest.`,
  );
await writeFile(
  join(target, "manifest.json"),
  `${JSON.stringify({ format: "postlet-backup-1", createdAt: new Date().toISOString(), source: client.url, accountId: client.accountId, emailState: before.state, mailboxes: mailboxes.list, emails }, null, 2)}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(`Backed up ${emails.length} emails to ${target}`);
