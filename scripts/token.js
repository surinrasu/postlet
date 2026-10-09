import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const directory = new URL("../.secrets/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const id = process.argv[2] || "owner";
if (!/^[a-z0-9_-]{1,64}$/.test(id))
  throw new Error(
    "Use a lowercase token name with letters, numbers, underscores or hyphens.",
  );
const scopes = (process.argv[3] || "read,write,send").split(",");
if (
  !scopes.includes("read") ||
  scopes.some((s) => !["read", "write", "send"].includes(s))
)
  throw new Error("Scopes must include read and may include write and send.");
const path = new URL("cloudflare.json", directory);
let existing;
try {
  existing = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  existing = { AUTH_TOKENS: "[]" };
}
const entries = JSON.parse(existing.AUTH_TOKENS);
if (entries.some((entry) => entry.id === id))
  throw new Error(
    `Token ${id} already exists. Choose a new name to rotate without overwriting credentials.`,
  );
const token = randomBytes(32).toString("base64url");
entries.push({
  id,
  sha256: createHash("sha256").update(token).digest("hex"),
  scopes,
});
existing.AUTH_TOKENS = JSON.stringify(entries);
await writeFile(new URL(`${id}.token`, directory), `${token}\n`, {
  mode: 0o600,
  flag: "wx",
});
await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, {
  mode: 0o600,
});
await writeFile(
  new URL("../.dev.vars", import.meta.url),
  `AUTH_TOKENS='${existing.AUTH_TOKENS}'\n`,
  { mode: 0o600 },
);
console.log(
  `Created .secrets/${id}.token and updated .secrets/cloudflare.json and .dev.vars. Token values are not printed.`,
);
