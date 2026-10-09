import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readToken, serviceUrl } from "./settings.js";

const origin = serviceUrl();
const token = await readToken();
const response = await fetch(new URL("/auth/bootstrap", origin), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
await mkdir(".secrets", { recursive: true, mode: 0o700 });
const file = resolve(".secrets/passkey-setup.url");
await writeFile(file, `${result.url}\n`, { mode: 0o600 });
await chmod(file, 0o600);
console.log(
  "Saved the single-use setup link to .secrets/passkey-setup.url. It expires in 10 minutes.",
);
if (process.platform === "darwin" && !process.argv.includes("--no-open")) {
  execFile("open", [result.url], (error) => {
    if (error) console.error("Open the setup link from the saved file.");
  });
  console.log(
    "Create a passkey in the browser, complete device verification and save the recovery codes.",
  );
}
