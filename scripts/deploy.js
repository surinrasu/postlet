import { spawnSync } from "node:child_process";
import { readDeployment, wranglerScript } from "./deployment.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run"))
  throw new Error(
    "Usage: POSTLET_CONFIG=<private-config> bun run deploy [--dry-run]",
  );
const { path } = await readDeployment();
const result = spawnSync(
  "node",
  [wranglerScript, "deploy", "--config", path, ...args],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
