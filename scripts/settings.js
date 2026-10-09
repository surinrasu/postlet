import { readFile } from "node:fs/promises";

export function serviceUrl(value = process.env.POSTLET_URL) {
  if (!value)
    throw new Error("Set POSTLET_URL to the service origin explicitly.");
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "POSTLET_URL must be an HTTPS origin (HTTP is allowed on loopback), without credentials, a path or query.",
    );
  return url.origin;
}

export async function readToken() {
  const token = (
    process.env.POSTLET_TOKEN ||
    (await readFile(
      process.env.POSTLET_TOKEN_FILE ||
        new URL("../.secrets/owner.token", import.meta.url),
      "utf8",
    ))
  ).trim();
  if (!token) throw new Error("The credential is empty.");
  return token;
}
