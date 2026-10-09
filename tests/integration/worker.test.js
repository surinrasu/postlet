import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CORE, MAIL, SUBMISSION } from "../../src/config.js";
import { sha256 } from "../../src/util.js";
import { workerModules } from "./modules.js";

let mf, directory, options;
const token = "local-integration-owner-token-not-a-production-secret";
const readToken = "local-integration-read-token-not-a-production-secret";
const root = "http://postlet.test";
const auth = { Authorization: `Bearer ${token}` };

async function api(calls, authorization = auth) {
  const response = await mf.dispatchFetch(`${root}/jmap`, {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: [CORE, MAIL, SUBMISSION],
      methodCalls: calls.map(([name, args], i) => [
        name,
        { accountId: "personal", ...args },
        String(i),
      ]),
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).methodResponses;
}

async function createEmail(extra = {}) {
  const result = await api([
    [
      "Email/set",
      {
        create: {
          draft: {
            mailboxIds: { m_drafts: true },
            keywords: { $draft: true },
            from: [{ email: "root@example.test" }],
            to: [{ email: "test@example.com" }],
            subject: `Test ${crypto.randomUUID()}`,
            textBody: [{ partId: "text", type: "text/plain" }],
            bodyValues: { text: { value: "你好，世界。 durable email body" } },
            ...extra,
          },
        },
      },
    ],
  ]);
  expect(result[0][0]).toBe("Email/set");
  expect(result[0][1].notCreated).toBeNull();
  return result[0][1].created.draft;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "postlet-test-"));
  options = convertV4MiniflareOptions({
    name: "postlet-test",
    modules: workerModules(),
    compatibilityDate: "2026-10-09",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    resourcePersistencePath: directory,
    unsafeTriggerHandlers: true,
    unsafeInspectDurableObjects: true,
    durableObjects: { ACCOUNT: { className: "MailAccount", useSQLite: true } },
    r2Buckets: ["MAIL"],
    email: { send_email: [{ name: "OUTBOUND" }] },
    bindings: {
      ACCOUNT_ID: "personal",
      MAIL_DOMAIN: "example.test",
      MAIL_ADDRESS: "root@example.test",
      MAIL_NAME: "Test",
      SEND_ENABLED: "true",
      MAX_MESSAGE_BYTES: "10485760",
      AUTH_TOKENS: JSON.stringify([
        {
          id: "owner",
          sha256: await sha256(token),
          scopes: ["read", "write", "send"],
        },
        { id: "reader", sha256: await sha256(readToken), scopes: ["read"] },
      ]),
    },
  });
  mf = new Miniflare(options);
  await mf.ready;
}, 30000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 15000);

test("requires authentication and publishes scoped JMAP session", async () => {
  expect((await mf.dispatchFetch(`${root}/.well-known/jmap`)).status).toBe(401);
  const response = await mf.dispatchFetch(`${root}/.well-known/jmap`, {
    headers: auth,
  });
  expect(response.status).toBe(200);
  const session = await response.json();
  expect(session.accounts.personal.isPersonal).toBe(true);
  expect(session.capabilities[SUBMISSION]).toEqual({});
  const readOnly = await (
    await mf.dispatchFetch(`${root}/.well-known/jmap`, {
      headers: { Authorization: `Bearer ${readToken}` },
    })
  ).json();
  expect(readOnly.accounts.personal.isReadOnly).toBe(true);
  expect(readOnly.capabilities[SUBMISSION]).toBeUndefined();
  expect(
    (
      await mf.dispatchFetch(`${root}/.well-known/jmap`, {
        headers: { ...auth, Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
});

test("creates drafts, resolves batch references and returns MIME body values", async () => {
  const created = await createEmail();
  const results = await api([
    ["Email/query", { filter: { inMailbox: "m_drafts" }, limit: 10 }],
    [
      "Email/get",
      {
        "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
        fetchTextBodyValues: true,
        properties: [
          "id",
          "blobId",
          "subject",
          "textBody",
          "bodyValues",
          "header:From:asAddresses",
        ],
      },
    ],
  ]);
  const message = results[1][1].list.find((item) => item.id === created.id);
  expect(message).toBeDefined();
  expect(Object.values(message.bodyValues)[0].value.trim()).toBe(
    "你好，世界。 durable email body",
  );
  expect(message["header:From:asAddresses"][0].email).toBe("root@example.test");
  expect(message._bodiesBlobId).toBeUndefined();
});

test("uploads, imports and downloads an attachment without altering bytes", async () => {
  const content = new Uint8Array([0, 1, 127, 128, 255]);
  const uploaded = await (
    await mf.dispatchFetch(`${root}/jmap/upload/personal`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: content,
    })
  ).json();
  const message = await createEmail({
    attachments: [
      {
        blobId: uploaded.blobId,
        name: "sample.bin",
        type: "application/octet-stream",
      },
    ],
  });
  const result = await api([
    [
      "Email/get",
      { ids: [message.id], properties: ["attachments", "hasAttachment"] },
    ],
  ]);
  expect(result[0][1].list[0].hasAttachment).toBe(true);
  const blobId = result[0][1].list[0].attachments[0].blobId;
  const download = await mf.dispatchFetch(
    `${root}/jmap/download/personal/${blobId}/sample.bin`,
    { headers: auth },
  );
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);
  expect(download.headers.get("Content-Disposition")).toContain("attachment");
  const raw =
    "From: outside@example.com\r\nTo: root@example.test\r\nSubject: imported\r\nMessage-ID: <import-1@example.com>\r\n\r\nBody";
  const rawBlob = await (
    await mf.dispatchFetch(`${root}/jmap/upload/personal`, {
      method: "POST",
      headers: auth,
      body: raw,
    })
  ).json();
  const imported = await api([
    [
      "Email/import",
      {
        emails: {
          incoming: { blobId: rawBlob.blobId, mailboxIds: { m_inbox: true } },
        },
      },
    ],
  ]);
  expect(imported[0][1].created.incoming.id).toMatch(/^e/);
});

test("increments unread counts, preserves memberships, and reports changes", async () => {
  const state = (await api([["Email/get", { ids: [] }]]))[0][1].state;
  const message = await createEmail({
    mailboxIds: { m_inbox: true, m_archive: true },
    keywords: {},
  });
  await api([
    [
      "Email/set",
      {
        update: {
          [message.id]: {
            "keywords/$seen": true,
            "mailboxIds/m_archive": null,
          },
        },
      },
    ],
  ]);
  const result = await api([
    ["Email/changes", { sinceState: state }],
    ["Email/get", { ids: [message.id] }],
    ["Mailbox/get", { ids: ["m_inbox"] }],
  ]);
  expect(result[0][1].created).toContain(message.id);
  expect(result[1][1].list[0].mailboxIds).toEqual({ m_inbox: true });
  expect(result[1][1].list[0].keywords.$seen).toBe(true);
  expect(result[2][1].list[0].unreadEmails).toBeLessThan(
    result[2][1].list[0].totalEmails,
  );
});

test("rejects stale conditional writes, including concurrent draft creation", async () => {
  const state = (await api([["Email/get", { ids: [] }]]))[0][1].state;
  const batch = () =>
    api([
      [
        "Email/set",
        {
          ifInState: state,
          create: {
            x: { mailboxIds: { m_drafts: true }, subject: "concurrent" },
          },
        },
      ],
    ]);
  const results = (await Promise.all([batch(), batch()])).flat();
  expect(results.filter(([name]) => name === "Email/set")).toHaveLength(1);
  expect(results.find(([name]) => name === "error")[1].type).toBe(
    "stateMismatch",
  );
});

test("queries Unicode text and calculates query changes", async () => {
  const original = (
    await api([
      [
        "Email/query",
        { filter: { subject: "query-diff-marker" }, calculateTotal: true },
      ],
    ])
  )[0][1];
  const email = await createEmail({ subject: "query-diff-marker" });
  const result = await api([
    [
      "Email/queryChanges",
      {
        filter: { subject: "query-diff-marker" },
        sinceQueryState: original.queryState,
      },
    ],
    ["Email/query", { filter: { body: "你好" } }],
    ["Email/query", { filter: { body: "durable" } }],
  ]);
  expect(result[0][1].added.map((item) => item.id)).toContain(email.id);
  expect(result[1][1].ids).toContain(email.id);
  expect(result[2][1].ids).toContain(email.id);
});

test("groups replies by References and tracks thread destruction", async () => {
  const parent = await createEmail({
    messageId: ["thread-parent@example.com"],
  });
  const reply = await createEmail({
    inReplyTo: ["thread-parent@example.com"],
    references: ["thread-parent@example.com"],
  });
  expect(reply.threadId).toBe(parent.threadId);
  const result = await api([["Thread/get", { ids: [parent.threadId] }]]);
  expect(result[0][1].list[0].emailIds).toContain(reply.id);
  await api([["Email/set", { destroy: [parent.id, reply.id] }]]);
  expect(
    (await api([["Thread/get", { ids: [parent.threadId] }]]))[0][1].notFound,
  ).toContain(parent.threadId);
});

test("enforces scopes and account isolation for mutations and blobs", async () => {
  const result = await api([["Email/set", { create: {} }]], {
    Authorization: `Bearer ${readToken}`,
  });
  expect(result[0][1].type).toBe("forbidden");
  const mismatch = await api([
    ["Email/get", { accountId: "someone-else", ids: [] }],
  ]);
  expect(mismatch[0][1].type).toBe("accountNotFound");
  expect(
    (
      await mf.dispatchFetch(`${root}/jmap/upload/personal`, {
        method: "POST",
        headers: { Authorization: `Bearer ${readToken}` },
        body: "x",
      })
    ).status,
  ).toBe(403);
});

test("validates parent cycles and mailbox deletion semantics", async () => {
  const created = await api([
    [
      "Mailbox/set",
      {
        create: {
          parent: { name: "Parent" },
          child: { name: "Child", parentId: "#parent" },
        },
      },
    ],
  ]);
  const parent = created[0][1].created.parent.id,
    child = created[0][1].created.child.id;
  const cycle = await api([
    ["Mailbox/set", { update: { [parent]: { parentId: child } } }],
  ]);
  expect(cycle[0][1].notUpdated[parent].type).toBe("invalidProperties");
  const remove = await api([["Mailbox/set", { destroy: [parent] }]]);
  expect(remove[0][1].notDestroyed[parent].type).toBe("mailboxHasChild");
});

test("submissions validate identities and can be canceled in the same batch", async () => {
  const email = await createEmail();
  const result = await api([
    [
      "EmailSubmission/set",
      { create: { sending: { emailId: email.id, identityId: "i_default" } } },
    ],
    [
      "EmailSubmission/set",
      { update: { "#sending": { undoStatus: "canceled" } } },
    ],
    ["EmailSubmission/get", { ids: ["#sending"] }],
  ]);
  expect(result[0][1].created.sending.id).toMatch(/^s/);
  expect(result[2][1].list[0].undoStatus).toBe("canceled");
  const spoofed = await createEmail({ from: [{ email: "spoof@example.com" }] });
  const bad = await api([
    [
      "EmailSubmission/set",
      { create: { bad: { emailId: spoofed.id, identityId: "i_default" } } },
    ],
  ]);
  expect(bad[0][1].notCreated.bad.type).toBe("forbiddenFrom");
});

test("MCP works with the official SDK and tools use the same mailbox", async () => {
  const client = new Client({ name: "postlet-tests", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${root}/mcp`), {
    requestInit: { headers: auth },
    fetch: (input, init) => mf.dispatchFetch(input.toString(), init),
  });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain("mail_draft");
  const draft = await client.callTool({
    name: "mail_draft",
    arguments: {
      to: ["test@example.com"],
      subject: "MCP shared core",
      text: "Hello from MCP",
    },
  });
  expect(draft.isError).not.toBe(true);
  const emailId = JSON.parse(draft.content[0].text).methodResponses[0][1]
    .created.draft.id;
  expect(
    (await api([["Email/get", { ids: [emailId] }]]))[0][1].list[0].subject,
  ).toBe("MCP shared core");
  await client.close();
}, 15000);

test("event source emits standard JMAP StateChange data", async () => {
  const response = await mf.dispatchFetch(
    `${root}/jmap/events?types=Email,Mailbox&closeafter=state`,
    { headers: auth },
  );
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  const text = await response.text();
  expect(text).toContain("event: state");
  expect(text).toContain('"@type":"StateChange"');
  expect(text).toContain('"personal"');
});

test("recovers raw inbound receipts and deduplicates redelivery", async () => {
  const bucket = await mf.getR2Bucket("MAIL");
  const raw = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: any-alias@example.test\r\nSubject: recover-incoming-marker\r\n\r\nDurable receipt",
  );
  const rawId = `b${await sha256(raw)}`;
  const ticket = {
    id: "receipt_test",
    blobId: rawId,
    size: raw.byteLength,
    createdAt: Date.now(),
    envelope: { from: "sender@example.com", to: "any-alias@example.test" },
  };
  await bucket.put(`blobs/${rawId}`, raw);
  const stub = (await mf.getDurableObjectNamespace("ACCOUNT")).getByName(
    "personal",
  );
  for (let i = 0; i < 2; i++) {
    await bucket.put(`incoming/${ticket.id}`, JSON.stringify(ticket));
    await stub.maintenance();
  }
  const result = await api([
    [
      "Email/query",
      { filter: { subject: "recover-incoming-marker" }, calculateTotal: true },
    ],
  ]);
  expect(result[0][1].total).toBe(1);
  expect(await bucket.get(`incoming/${ticket.id}`)).toBeNull();
}, 15000);

test("mail and sync states survive a complete runtime restart", async () => {
  const message = await createEmail({ subject: "persistence-marker" });
  const state = (await api([["Email/get", { ids: [message.id] }]]))[0][1].state;
  await mf.dispose();
  mf = new Miniflare(options);
  await mf.ready;
  const result = await api([
    ["Email/get", { ids: [message.id] }],
    ["Email/changes", { sinceState: state }],
  ]);
  expect(result[0][1].list[0].subject).toBe("persistence-marker");
  expect(result[1][1].newState).toBe(state);
  expect(result[1][1].created).toEqual([]);
}, 30000);

test("rejects malformed requests before mutation and keeps method errors local", async () => {
  const malformed = await mf.dispatchFetch(`${root}/jmap`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ using: [CORE], methodCalls: "invalid" }),
  });
  expect(malformed.status).toBe(400);
  expect((await malformed.json()).type).toBe(
    "urn:ietf:params:jmap:error:notRequest",
  );
  const results = await api([
    ["Email/get", { ids: "invalid" }],
    ["Core/echo", { value: "still executes" }],
  ]);
  expect(results[0][1].type).toBe("invalidArguments");
  expect(results[1][1].value).toBe("still executes");
});

test("handles legal creation ids that resemble JavaScript prototype properties", async () => {
  const create = JSON.parse(
    '{"__proto__":{"mailboxIds":{"m_drafts":true},"subject":"prototype-key"}}',
  );
  const result = await api([["Email/set", { create }]]);
  expect(result[0][1].created.__proto__.id).toMatch(/^e/);
});

test("submits to the local email simulator and retains delivery uncertainty", async () => {
  const message = await createEmail({ subject: "local-outbound-simulator" });
  const result = await api([
    [
      "EmailSubmission/set",
      {
        create: { send: { identityId: "i_default", emailId: message.id } },
        onSuccessUpdateEmail: {
          "#send": { "keywords/$draft": null, mailboxIds: { m_sent: true } },
        },
      },
    ],
  ]);
  const id = result[0][1].created.send.id;
  expect(result[1][0]).toBe("Email/set");
  let submission;
  for (let i = 0; i < 30; i++) {
    submission = (await api([["EmailSubmission/get", { ids: [id] }]]))[0][1]
      .list[0];
    if (submission.undoStatus === "final") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(submission.undoStatus).toBe("final");
  expect(submission.deliveryStatus["test@example.com"].smtpReply).toContain(
    "250",
  );
  expect(submission.deliveryStatus["test@example.com"].delivered).toBe(
    "unknown",
  );
});

test("recovers a crashed network attempt without resending the message", async () => {
  const message = await createEmail();
  const created = await api([
    [
      "EmailSubmission/set",
      {
        create: {
          interrupted: { identityId: "i_default", emailId: message.id },
        },
      },
    ],
    [
      "EmailSubmission/set",
      { update: { "#interrupted": { undoStatus: "canceled" } } },
    ],
  ]);
  const id = created[0][1].created.interrupted.id;
  const storage = await mf.unsafeGetDurableObjectStorage(
    "postlet-test",
    "MailAccount",
    { name: "personal" },
  );
  await storage.exec(
    "UPDATE outbox SET status='sending',attempt_at=? WHERE id=?",
    Date.now() - 10 * 60 * 1000,
    id,
  );
  const stub = (await mf.getDurableObjectNamespace("ACCOUNT")).getByName(
    "personal",
  );
  await stub.maintenance();
  const status = await stub.status();
  expect(status.uncertainOutbound.some((s) => s.id === id)).toBe(true);
  expect(
    (await api([["EmailSubmission/get", { ids: [id] }]]))[0][1].list[0]
      .undoStatus,
  ).toBe("final");
});

test("email handler accepts aliases and rejects foreign recipient domains", async () => {
  const raw =
    "From: sender@example.com\r\nTo: alias@example.test\r\nSubject: email-handler-marker\r\nMessage-ID: <handler@example.com>\r\n\r\nInbound email event";
  const response = await mf.dispatchFetch(
    `${root}/cdn-cgi/local/email?from=sender@example.com&to=alias@example.test`,
    { method: "POST", body: raw },
  );
  expect(response.status).toBe(200);
  const stub = (await mf.getDurableObjectNamespace("ACCOUNT")).getByName(
    "personal",
  );
  await stub.maintenance();
  const result = await api([
    [
      "Email/query",
      { filter: { subject: "email-handler-marker" }, calculateTotal: true },
    ],
  ]);
  expect(result[0][1].total).toBe(1);
  const rejected = await mf.dispatchFetch(
    `${root}/cdn-cgi/local/email?from=sender@example.com&to=someone@foreign.example`,
    { method: "POST", body: raw },
  );
  const events = await rejected.text();
  expect(events).toContain("Recipient domain is not configured");
});

test("validates alias identities and rejects malformed reply and Bcc addresses", async () => {
  const [result] = await api([
    [
      "Identity/set",
      {
        create: {
          alias: {
            email: "alias@example.test",
            replyTo: [{ email: "root@example.test" }],
            bcc: [],
          },
          foreign: { email: "someone@example.com" },
          malformed: {
            email: "alias@example.test",
            bcc: "root@example.test",
          },
          injected: {
            email: "alias@example.test",
            replyTo: [
              {
                email: "root@example.test",
                name: "name\r\nBcc: other@example.com",
              },
            ],
          },
        },
      },
    ],
  ]);
  expect(result[1].created.alias.id).toMatch(/^i/);
  for (const key of ["foreign", "malformed", "injected"])
    expect(result[1].notCreated[key].type).toBe("invalidProperties");
  const id = result[1].created.alias.id;
  const [updated] = await api([
    ["Identity/set", { update: { [id]: { bcc: [{ email: "invalid" }] } } }],
  ]);
  expect(updated[1].notUpdated[id].type).toBe("invalidProperties");
  const [unchanged] = await api([["Identity/get", { ids: [id] }]]);
  expect(unchanged[1].list[0].bcc).toEqual([]);
});

test("exports and restores MIME, mailbox hierarchy and flags with resumable imports", async () => {
  const folder = await api([
    [
      "Mailbox/set",
      {
        create: {
          parent: { name: "Backup parent" },
          child: { name: "Backup child", parentId: "#parent" },
        },
      },
    ],
  ]);
  const childId = folder[0][1].created.child.id;
  const original = await createEmail({
    subject: "backup-roundtrip-marker",
    mailboxIds: { [childId]: true },
    keywords: { $seen: true, custom: true },
    receivedAt: "2024-02-03T04:05:06Z",
  });
  const backupRoot = await mkdtemp(join(tmpdir(), "postlet-backup-test-"));
  const target = join(backupRoot, "export");
  const env = {
    ...process.env,
    POSTLET_URL: String(await mf.ready).replace(/\/$/, ""),
    POSTLET_TOKEN: token,
  };
  const execute = (script) =>
    promisify(execFile)(process.execPath, [script, target], { env });
  try {
    await execute("scripts/backup.js");
    const manifest = JSON.parse(
      await readFile(join(target, "manifest.json"), "utf8"),
    );
    const item = manifest.emails.find((email) => email.id === original.id);
    expect(item.keywords).toEqual({ $seen: true, custom: true });
    expect(Date.parse(item.receivedAt)).toBe(
      Date.parse("2024-02-03T04:05:06Z"),
    );
    const exported = await readFile(
      join(target, "messages", `${original.id}.eml`),
    );
    const removed = await api([
      ["Email/set", { destroy: [original.id] }],
      ["Mailbox/set", { destroy: [childId, folder[0][1].created.parent.id] }],
    ]);
    expect(removed[1][1].notDestroyed).toBeNull();
    const [before] = await api([["Email/query", { calculateTotal: true }]]);
    await execute("scripts/restore.js");
    const [after] = await api([["Email/query", { calculateTotal: true }]]);
    expect(after[1].total).toBe(before[1].total + manifest.emails.length);
    await execute("scripts/restore.js");
    const [resumed] = await api([["Email/query", { calculateTotal: true }]]);
    expect(resumed[1].total).toBe(after[1].total);
    const results = await api([
      ["Email/query", { filter: { subject: "backup-roundtrip-marker" } }],
      [
        "Email/get",
        { "#ids": { resultOf: "0", name: "Email/query", path: "/ids" } },
      ],
    ]);
    const restored = results[1][1].list.find(
      (email) => email.id !== original.id,
    );
    const [folders] = await api([["Mailbox/get", {}]]);
    const restoredChild = folders[1].list.find(
      (mailbox) => mailbox.name === "Backup child",
    );
    const restoredParent = folders[1].list.find(
      (mailbox) => mailbox.name === "Backup parent",
    );
    expect(restoredChild.id).not.toBe(childId);
    expect(restoredChild.parentId).toBe(restoredParent.id);
    expect(restored.mailboxIds).toEqual({ [restoredChild.id]: true });
    expect(restored.keywords).toEqual(item.keywords);
    expect(restored.receivedAt).toBe(item.receivedAt);
    const raw = await mf.dispatchFetch(
      `${root}/jmap/download/personal/${restored.blobId}/message.eml`,
      { headers: auth },
    );
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(exported);
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
});
