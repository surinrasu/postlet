import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceUrl } from "./settings.js";

export const wranglerScript = fileURLToPath(
  new URL("bin/wrangler.js", import.meta.resolve("wrangler/package.json")),
);

export async function readDeployment() {
  if (!process.env.POSTLET_CONFIG)
    throw new Error(
      "Set POSTLET_CONFIG to your private deployment configuration, for example wrangler.production.jsonc.",
    );
  const path = resolve(process.env.POSTLET_CONFIG);
  // Use Wrangler's pinned parser so JSONC comments and relative paths work.
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({ config: path });
  if (!config.vars?.PUBLIC_URL)
    throw new Error("Set PUBLIC_URL in the deployment configuration.");
  const origin = serviceUrl(config.vars?.PUBLIC_URL);
  const hostname = new URL(origin).hostname;
  const domain = config.vars?.MAIL_DOMAIN;
  const reserved = (name) =>
    /(^|\.)(localhost|test|invalid|example|example\.(com|net|org))$/.test(name);
  if (
    !/^[a-f0-9]{32}$/i.test(config.account_id || "") ||
    !config.name ||
    !domain ||
    reserved(domain) ||
    reserved(hostname) ||
    new URL(origin).protocol !== "https:" ||
    !config.vars?.MAIL_ADDRESS?.endsWith(`@${domain}`)
  )
    throw new Error(
      "Configure a real account_id, Worker name, MAIL_DOMAIN, MAIL_ADDRESS and HTTPS PUBLIC_URL before using deployment commands.",
    );
  return { path, config, origin };
}
