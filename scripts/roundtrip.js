import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "./client.js";

const action = process.argv[2];
if (!["prepare", "send", "check"].includes(action))
  throw new Error("Usage: bun scripts/roundtrip.js prepare|send|check");
const client = await connect();
const path = new URL("../.secrets/roundtrip.json", import.meta.url);
if (action === "prepare") {
  await mkdir(new URL("../.secrets/", import.meta.url), {
    recursive: true,
    mode: 0o700,
  });
  const [identities] = await client.jmap([
    ["Identity/get", { ids: ["i_default"] }],
  ]);
  const address = identities.list[0]?.email;
  if (!address) throw new Error("The account has no default sending identity.");
  const marker = crypto.randomUUID().slice(0, 8);
  const test = {
    origin: client.url,
    accountId: client.accountId,
    subject: `Postlet round-trip test ${marker}`,
    from: address,
    to: `postlet-test+${marker}@${address.split("@")[1]}`,
    text: "Postlet 收发链路测试：JMAP → Cloudflare Email Sending → Email Routing → JMAP。仅包含本测试文本，不包含私人数据。",
  };
  const [result] = await client.jmap([
    [
      "Email/set",
      {
        create: {
          test: {
            mailboxIds: { m_drafts: true },
            keywords: { $draft: true },
            subject: test.subject,
            from: [{ email: test.from }],
            to: [{ email: test.to }],
            textBody: [{ partId: "text", type: "text/plain" }],
            bodyValues: { text: { value: test.text } },
          },
        },
      },
    ],
  ]);
  test.emailId = result.created.test.id;
  await writeFile(path, `${JSON.stringify(test, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ ...test, status: "draft; not sent" }, null, 2));
} else {
  const test = JSON.parse(await readFile(path, "utf8"));
  if (test.origin !== client.url || test.accountId !== client.accountId)
    throw new Error(
      "This draft was prepared for a different endpoint or account. Review the saved roundtrip record before proceeding.",
    );
  if (action === "send") {
    if (test.submissionId || test.attemptedAt)
      throw new Error(
        "A send was already attempted. Use check and inspect the existing submission before any retry.",
      );
    // Record the attempt locally before sending, including across a lost response.
    test.attemptedAt = new Date().toISOString();
    await writeFile(path, `${JSON.stringify(test, null, 2)}\n`, {
      mode: 0o600,
    });
    const [result] = await client.jmap([
      [
        "EmailSubmission/set",
        {
          create: { test: { emailId: test.emailId, identityId: "i_default" } },
          onSuccessUpdateEmail: {
            "#test": { "keywords/$draft": null, mailboxIds: { m_sent: true } },
          },
        },
      ],
    ]);
    test.submissionId = result.created.test.id;
    await writeFile(path, `${JSON.stringify(test, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ submissionId: test.submissionId, status: "submitted" }),
    );
  } else {
    const [incoming, submissions] = await client.jmap([
      [
        "Email/query",
        {
          filter: { inMailbox: "m_inbox", subject: test.subject },
          calculateTotal: true,
        },
      ],
      [
        "EmailSubmission/query",
        { filter: { emailIds: [test.emailId] }, limit: 10 },
      ],
    ]);
    const [details, messages] = await client.jmap([
      ["EmailSubmission/get", { ids: submissions.ids }],
      [
        "Email/get",
        {
          ids: incoming.ids,
          fetchTextBodyValues: true,
          properties: [
            "id",
            "subject",
            "from",
            "to",
            "bodyValues",
            "header:Authentication-Results:asText:all",
          ],
        },
      ],
    ]);
    const verified = messages.list.map((message) => ({
      id: message.id,
      contentMatches:
        message.subject === test.subject &&
        message.from?.some((a) => a.email === test.from) &&
        message.to?.some((a) => a.email === test.to) &&
        Object.values(message.bodyValues || {}).some(
          (body) => body.value.trim() === test.text,
        ),
      authentication: message["header:Authentication-Results:asText:all"],
    }));
    console.log(
      JSON.stringify(
        {
          received: incoming.total,
          inboxIds: incoming.ids,
          verified,
          submissions: details.list,
        },
        null,
        2,
      ),
    );
  }
}
