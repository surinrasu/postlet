import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serviceUrl } from "./settings.js";

// Read-only checks with an isolated configuration. Neither the existing
// Himalaya configuration nor message flags are changed; nothing is sent.
const exec = promisify(execFile);
const origin = serviceUrl();
const address = process.env.POSTLET_MAIL_ADDRESS;
if (!address)
  throw new Error(
    "Set POSTLET_MAIL_ADDRESS to the account's primary email address.",
  );
const tokenFile = resolve(
  process.argv[2] ||
    process.env.POSTLET_TOKEN_FILE ||
    ".secrets/himalaya.token",
);
const directory = await mkdtemp(join(tmpdir(), "postlet-himalaya-"));
try {
  const config = join(directory, "config.toml");
  await writeFile(
    config,
    `[accounts.postlet]\ndefault = true\nemail = ${JSON.stringify(address)}\njmap.server = ${JSON.stringify(new URL("/.well-known/jmap", origin).href)}\njmap.auth.basic.username = ${JSON.stringify(address)}\njmap.auth.basic.password.command = ${JSON.stringify(["cat", tokenFile])}\n`,
    { mode: 0o600 },
  );
  const run = async (args) => {
    const { stdout } = await exec("himalaya", [
      "--config",
      config,
      "--log-level",
      "off",
      "--json",
      ...args,
    ]);
    return JSON.parse(stdout);
  };
  const mailboxes = await run(["mailbox", "list"]);
  const identities = await run(["jmap", "identity", "get"]);
  const envelopes = await run(["envelope", "list", "--page-size", "5"]);
  const list = Array.isArray(envelopes)
    ? envelopes
    : envelopes.envelopes || envelopes.list || [];
  if (list[0]?.id) await run(["message", "read", String(list[0].id)]);
  console.log(
    JSON.stringify({
      client: "himalaya",
      mailboxes: Array.isArray(mailboxes) ? mailboxes.length : "ok",
      identities: identities ? "ok" : "empty",
      envelopes: list.length,
      messageRead: !!list[0]?.id,
      credentialsPrinted: false,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
