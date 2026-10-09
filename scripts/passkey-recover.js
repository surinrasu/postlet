import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readDeployment, wranglerScript } from "./deployment.js";
import { serviceUrl } from "./settings.js";

// Cloudflare account access is the final recovery authority. A new random,
// single-use secret authorizes only a 10-minute replacement-passkey ceremony.
const exec = promisify(execFile);
const { path: configPath, origin } = await readDeployment();
if (process.env.POSTLET_URL && serviceUrl() !== origin)
  throw new Error(
    "POSTLET_URL must match PUBLIC_URL in POSTLET_CONFIG for administrative recovery.",
  );
const secret = randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(secret).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "postlet-recovery-"));
const temporary = join(directory, "secret.json");
let installed = false;
try {
  await writeFile(
    temporary,
    JSON.stringify({ PASSKEY_RECOVERY_SHA256: digest }),
    { mode: 0o600 },
  );
  console.log(
    "Installing a single-use recovery credential with the authenticated Wrangler account…",
  );
  await exec("node", [
    wranglerScript,
    "secret",
    "bulk",
    temporary,
    "--config",
    configPath,
  ]);
  installed = true;
  const response = await fetch(new URL("/auth/admin-recovery", origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  await mkdir(".secrets", { recursive: true, mode: 0o700 });
  const file = resolve(".secrets/passkey-setup.url");
  await writeFile(file, `${result.url}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  console.log(
    "Saved the 10-minute recovery link to .secrets/passkey-setup.url.",
  );
  if (process.platform === "darwin" && !process.argv.includes("--no-open"))
    await exec("open", [result.url]);
} finally {
  await rm(directory, { recursive: true, force: true });
  if (installed) {
    try {
      await exec("node", [
        wranglerScript,
        "secret",
        "delete",
        "PASSKEY_RECOVERY_SHA256",
        "--config",
        configPath,
      ]);
    } catch {
      console.error(
        'Run: wrangler secret delete PASSKEY_RECOVERY_SHA256 --config "$POSTLET_CONFIG". The used recovery credential cannot be replayed.',
      );
    }
  }
}
