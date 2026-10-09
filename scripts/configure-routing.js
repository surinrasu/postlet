import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readDeployment } from "./deployment.js";

// Wrangler 4.149 rejects worker catch-all actions before contacting the API.
// Use the existing OAuth session, without printing or copying its credentials.
const { config } = await readDeployment();
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  const locations = process.env.WRANGLER_AUTH_FILE
    ? [process.env.WRANGLER_AUTH_FILE]
    : [
        join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
        join(
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
          ".wrangler/config/default.toml",
        ),
        join(homedir(), ".wrangler/config/default.toml"),
      ];
  for (const location of locations) {
    try {
      const auth = Bun.TOML.parse(await readFile(location, "utf8"));
      if (
        auth.expiration_time &&
        Date.parse(auth.expiration_time) <= Date.now()
      )
        throw new Error(
          "Wrangler session expired. Run wrangler whoami to refresh it first.",
        );
      token = auth.oauth_token;
      if (token) break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
if (!token)
  throw new Error(
    "No API token or Wrangler OAuth session found. Set WRANGLER_AUTH_FILE if using a different profile.",
  );
async function api(path, method = "GET", body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new Error(
      `Cloudflare HTTP ${response.status}; error codes: ${(result.errors || []).map((e) => e.code).join(", ")}`,
    );
  return result.result;
}
const zones = await api(
  `/zones?name=${encodeURIComponent(config.vars.MAIL_DOMAIN)}&account.id=${config.account_id}`,
);
if (zones.length !== 1)
  throw new Error("Expected exactly one zone in the configured account.");
const path = `/zones/${zones[0].id}/email/routing/rules/catch_all`;
const previous = await api(path);
const ownsRule = previous.actions?.every(
  (action) =>
    action.type === "worker" &&
    action.value?.length === 1 &&
    action.value[0] === config.name,
);
if (previous.enabled && !ownsRule)
  throw new Error(
    "An enabled catch-all already serves another destination. Review it before replacing it.",
  );
await api(path, "PUT", {
  actions: [{ type: "worker", value: [config.name] }],
  enabled: true,
  matchers: [{ type: "all" }],
  name: "Postlet catch-all",
});
const rule = await api(path);
console.log(
  JSON.stringify(
    {
      domain: config.vars.MAIL_DOMAIN,
      enabled: rule.enabled,
      actions: rule.actions,
    },
    null,
    2,
  ),
);
