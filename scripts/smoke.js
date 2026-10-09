import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connect } from "./client.js";

const client = await connect();
assert.equal((await fetch(`${client.url}/.well-known/jmap`)).status, 401);
const [mailboxes] = await client.jmap([["Mailbox/get", {}]]);
assert(mailboxes.list.some((m) => m.role === "inbox"));
const marker = `Postlet deployment check ${crypto.randomUUID()}`;
let emailId;
try {
  const [created] = await client.jmap([
    [
      "Email/set",
      {
        create: {
          smoke: {
            mailboxIds: { m_drafts: true },
            keywords: { $draft: true },
            subject: marker,
            textBody: [{ partId: "text", type: "text/plain" }],
            bodyValues: {
              text: {
                value:
                  "Deployment verification only. This draft is never submitted.",
              },
            },
          },
        },
      },
    ],
  ]);
  emailId = created.created.smoke.id;
  const [emails] = await client.jmap([
    ["Email/get", { ids: [emailId], fetchTextBodyValues: true }],
  ]);
  assert.equal(emails.list[0].subject, marker);
  assert.equal(
    (
      await fetch(client.downloadUrl(emails.list[0].blobId), {
        headers: client.headers,
      })
    ).status,
    200,
  );
  const [changed] = await client.jmap([
    [
      "Email/set",
      {
        ifInState: emails.state,
        update: { [emailId]: { "keywords/$seen": true } },
      },
    ],
  ]);
  assert(changed.newState !== emails.state);
  const events = await fetch(
    `${client.url}/jmap/events?types=Email&closeafter=state`,
    { headers: client.headers },
  );
  assert((await events.text()).includes('"@type":"StateChange"'));
  const mcp = new Client({ name: "postlet-smoke", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${client.url}/mcp`), {
      requestInit: { headers: client.headers },
    }),
  );
  const tools = await mcp.listTools();
  assert(tools.tools.some((tool) => tool.name === "mail_read"));
  const status = await mcp.callTool({ name: "mail_status", arguments: {} });
  assert(!status.isError);
  await mcp.close();
  console.log(
    JSON.stringify(
      {
        url: client.url,
        authentication: "passed",
        jmap: "passed",
        r2: "passed",
        sync: "passed",
        sse: "passed",
        mcp: "passed",
        status: JSON.parse(status.content[0].text),
      },
      null,
      2,
    ),
  );
} finally {
  if (emailId) await client.jmap([["Email/set", { destroy: [emailId] }]]);
}
