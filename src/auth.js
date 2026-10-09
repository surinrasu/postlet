import { timingSafeEqual } from "node:crypto";
import { encoder, sha256 } from "./util.js";

export function requestToken(request, env) {
  let token;
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) token = header.slice(7);
  else if (header.startsWith("Basic ")) {
    try {
      const value = atob(header.slice(6));
      const split = value.indexOf(":");
      if (
        value.slice(0, split).toLowerCase() === env.MAIL_ADDRESS.toLowerCase()
      )
        token = value.slice(split + 1);
    } catch {
      return null;
    }
  }
  return token && token.length >= 32 && token.length <= 2048 ? token : null;
}

export async function authenticate(request, env, { staticOnly = false } = {}) {
  const token = requestToken(request, env);
  if (!token) return null;
  if (!staticOnly && env.AUTH) {
    const origin = new URL(env.PUBLIC_URL || "https://localhost:8787").origin;
    const resource = new URL(request.url).pathname === "/mcp" ? "mcp" : "jmap";
    const auth = await env.AUTH.getByName("owner").validate(
      token,
      `${origin}/${resource}`,
    );
    if (!auth?.legacyAllowed)
      return auth ? { id: auth.id, scopes: [...auth.scopes] } : null;
  }
  let entries;
  try {
    entries = JSON.parse(env.AUTH_TOKENS || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const digest = await sha256(token);
  for (const entry of entries) {
    if (
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Array.isArray(entry.scopes)
    )
      continue;
    const equal = timingSafeEqual(
      encoder.encode(digest),
      encoder.encode(entry.sha256),
    );
    if (
      equal &&
      (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())
    ) {
      return {
        id: entry.id,
        scopes: entry.scopes.filter((scope) =>
          ["read", "write", "send"].includes(scope),
        ),
      };
    }
  }
  return null;
}

export function unauthorized(request, env) {
  const origin = new URL(env?.PUBLIC_URL || "https://localhost:8787").origin;
  const resource =
    request && new URL(request.url).pathname === "/mcp" ? "mcp" : "jmap";
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="postlet", resource_metadata="${origin}/.well-known/oauth-protected-resource/${resource}", scope="read"`,
        "Cache-Control": "no-store",
      },
    },
  );
}
