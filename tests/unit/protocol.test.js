import { describe, expect, test } from "bun:test";
import { authenticate } from "../../src/auth.js";
import { composeMessage, parseMessage, withoutBcc } from "../../src/mime.js";
import { diffIds } from "../../src/query.js";
import {
  applyPatch,
  resolvePointer,
  sha256,
  truncateUtf8,
} from "../../src/util.js";

describe("JMAP protocol primitives", () => {
  test("patches escaped paths without mutating the original", () => {
    const before = { keywords: { $seen: true }, "x/y": { "a~b": 1 } };
    expect(
      applyPatch(before, {
        "keywords/$seen": null,
        "keywords/$flagged": true,
        "x~1y/a~0b": 2,
      }),
    ).toEqual({ keywords: { $flagged: true }, "x/y": { "a~b": 2 } });
    expect(before.keywords.$seen).toBe(true);
    expect(() =>
      applyPatch(before, { keywords: {}, "keywords/$seen": true }),
    ).toThrow();
    expect(() => applyPatch({}, { "__proto__/polluted": true })).toThrow();
    expect({}.polluted).toBeUndefined();
  });
  test("resolves array wildcards and rejects absent result paths", () => {
    expect(
      resolvePointer(
        { list: [{ emailIds: ["a", "b"] }, { emailIds: ["c"] }] },
        "/list/*/emailIds",
      ),
    ).toEqual(["a", "b", "c"]);
    expect(() => resolvePointer({}, "/missing")).toThrow();
  });
  test("UTF-8 byte truncation never splits a character", () => {
    expect(truncateUtf8("你好吗", 5)).toEqual({
      value: "你",
      isTruncated: true,
    });
    expect(truncateUtf8("a😀b", 5)).toEqual({
      value: "a😀",
      isTruncated: true,
    });
    expect(truncateUtf8("abc", 3)).toEqual({
      value: "abc",
      isTruncated: false,
    });
  });
  test("query diffs reconstruct insertions, removals and reorderings", () => {
    for (const [old, next] of [
      [[], ["a"]],
      [["a", "b"], []],
      [
        ["a", "b", "c"],
        ["c", "b", "d", "a"],
      ],
      [
        ["a", "b"],
        ["x", "a", "b"],
      ],
    ]) {
      const diff = diffIds(old, next);
      const applied = old.filter((id) => !diff.removed.includes(id));
      for (const item of diff.added) applied.splice(item.index, 0, item.id);
      expect(applied).toEqual(next);
    }
  });
});

describe("MIME", () => {
  test("round trips Unicode, alternatives, attachments and threading", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const raw = await composeMessage(
      {
        from: [{ email: "root@example.test", name: "测试用户" }],
        to: [{ email: "test@example.com", name: "Test, User" }],
        bcc: [{ email: "hidden@example.com" }],
        subject: "测试邮件 📨",
        inReplyTo: ["parent@example.com"],
        textBody: [{ partId: "t" }],
        htmlBody: [{ partId: "h" }],
        bodyValues: { t: { value: "纯文本正文" }, h: { value: "<p>正文</p>" } },
        attachments: [
          {
            blobId: "file",
            type: "application/octet-stream",
            name: "附件.bin",
          },
        ],
      },
      { MAIL_DOMAIN: "example.test", MAIL_ADDRESS: "root@example.test" },
      async () => new Blob([bytes]),
    );
    const blobs = [];
    const parsed = await parseMessage(raw, async (value) => {
      blobs.push(value);
      return `b${blobs.length}`;
    });
    expect(parsed.data.subject).toBe("测试邮件 📨");
    expect(parsed.data.from[0].name).toBe("测试用户");
    expect(parsed.data.to[0].name).toBe("Test, User");
    expect(parsed.data.inReplyTo).toEqual(["parent@example.com"]);
    expect(parsed.data.bodyStructure.type).toBe("multipart/mixed");
    expect(parsed.data.textBody[0].type).toBe("text/plain");
    expect(parsed.data.htmlBody[0].type).toBe("text/html");
    expect(parsed.data.attachments[0].name).toBe("附件.bin");
    expect(blobs.at(-1)).toEqual(bytes);
    const sent = await parseMessage(withoutBcc(raw), async () => "blob");
    expect(sent.data.bcc).toBeNull();
    expect(sent.data.subject).toBe(parsed.data.subject);
  });
  test("blocks CRLF injection in headers and sender names", async () => {
    const env = {
      MAIL_ADDRESS: "root@example.test",
      MAIL_DOMAIN: "example.test",
    };
    await expect(
      composeMessage(
        { subject: "x\r\nBcc: victim@example.com" },
        env,
        () => null,
      ),
    ).rejects.toThrow();
    await expect(
      composeMessage(
        {
          from: [
            { email: "root@example.test", name: "x\nTo: other@example.com" },
          ],
        },
        env,
        () => null,
      ),
    ).rejects.toThrow();
  });
  test("decodes quoted printable and non-UTF8 charsets", async () => {
    const raw = new TextEncoder().encode(
      "From: test@example.com\r\nSubject: =?ISO-8859-1?Q?caf=E9?=\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9",
    );
    const parsed = await parseMessage(raw, async () => "blob");
    expect(parsed.data.subject).toBe("café");
    expect(parsed.bodies["1"].value.trim()).toBe("café");
  });
});

test("access tokens are scoped, support Basic, and fail closed", async () => {
  const token = "a".repeat(43);
  const env = {
    MAIL_ADDRESS: "root@example.test",
    AUTH_TOKENS: JSON.stringify([
      { id: "reader", sha256: await sha256(token), scopes: ["read"] },
    ]),
  };
  const request = (authorization) =>
    new Request("https://mail.example.com", { headers: { authorization } });
  expect((await authenticate(request(`Bearer ${token}`), env)).scopes).toEqual([
    "read",
  ]);
  expect(
    (
      await authenticate(
        request(`Basic ${btoa(`root@example.test:${token}`)}`),
        env,
      )
    ).id,
  ).toBe("reader");
  expect(
    await authenticate(request(`Bearer ${"b".repeat(43)}`), env),
  ).toBeNull();
  expect(
    await authenticate(request(`Bearer ${token}`), {
      ...env,
      AUTH_TOKENS: "invalid",
    }),
  ).toBeNull();
});
