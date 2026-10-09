import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connect } from "./client.js";

if (!process.argv[2])
  throw new Error("Usage: bun scripts/restore.js <backup-directory>");
const directory = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(join(directory, "manifest.json"), "utf8"),
);
if (manifest.format !== "postlet-backup-1")
  throw new Error("Unsupported backup format");
const client = await connect();
const targetKey = createHash("sha256")
  .update(`${client.url}:${client.accountId}`)
  .digest("hex")
  .slice(0, 16);
const journalFile = join(directory, `restore-${targetKey}.json`);
let journal;
try {
  journal = JSON.parse(await readFile(journalFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  journal = { mailboxes: {}, emails: {} };
}
const save = async () => {
  const temporary = `${journalFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, journalFile);
};
const [existing] = await client.jmap([["Mailbox/get", {}]]);
for (const mailbox of manifest.mailboxes)
  if (mailbox.role) {
    const match = existing.list.find((m) => m.role === mailbox.role);
    if (!match)
      throw new Error(`Target lacks required system mailbox ${mailbox.role}`);
    journal.mailboxes[mailbox.id] = match.id;
  }
const pending = manifest.mailboxes.filter((m) => !journal.mailboxes[m.id]);
while (pending.length) {
  const index = pending.findIndex(
    (m) => !m.parentId || journal.mailboxes[m.parentId],
  );
  if (index < 0) throw new Error("Backup mailbox hierarchy is invalid");
  const [mailbox] = pending.splice(index, 1);
  const parentId = mailbox.parentId
    ? journal.mailboxes[mailbox.parentId]
    : null;
  const match = existing.list.find(
    (m) => m.name === mailbox.name && m.parentId === parentId,
  );
  if (match) journal.mailboxes[mailbox.id] = match.id;
  else {
    const [created] = await client.jmap([
      [
        "Mailbox/set",
        {
          create: {
            restored: {
              name: mailbox.name,
              parentId,
              sortOrder: mailbox.sortOrder,
              isSubscribed: mailbox.isSubscribed,
            },
          },
        },
      ],
    ]);
    journal.mailboxes[mailbox.id] = created.created.restored.id;
  }
  await save();
}
for (const email of manifest.emails) {
  if (journal.emails[email.id]) continue;
  if (!/^[A-Za-z0-9_-]+$/.test(email.id))
    throw new Error("Invalid email id in backup");
  const raw = await readFile(join(directory, "messages", `${email.id}.eml`));
  const uploadUrl = client.session.uploadUrl.replace(
    "{accountId}",
    encodeURIComponent(client.accountId),
  );
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...client.headers, "Content-Type": "message/rfc822" },
    body: raw,
  });
  if (!upload.ok) throw new Error(`Upload failed: HTTP ${upload.status}`);
  const { blobId } = await upload.json();
  const mailboxIds = Object.fromEntries(
    Object.keys(email.mailboxIds).map((id) => {
      if (!journal.mailboxes[id]) throw new Error("Unknown mailbox in backup");
      return [journal.mailboxes[id], true];
    }),
  );
  const [result] = await client.jmap([
    [
      "Email/import",
      {
        emails: {
          restored: {
            blobId,
            mailboxIds,
            keywords: email.keywords,
            receivedAt: email.receivedAt,
          },
        },
      },
    ],
  ]);
  journal.emails[email.id] = result.created.restored.id;
  await save();
}
console.log(
  `Restored ${Object.keys(journal.emails).length} emails. No messages were sent. Resume progress is stored in ${journalFile}`,
);
