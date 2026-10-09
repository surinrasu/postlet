import { authAsset, loginPage } from "../passkey-ui.js";
import { sha256 } from "../util.js";
import {
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "./ceremonies.js";
import {
  deleteKey,
  issueAppPassword,
  renewKey,
  replaceRecoveryCodes,
  revokeAppPassword,
} from "./credentials.js";
import { revokeGrant } from "./oauth.js";
import { AuthError, check } from "./policy.js";
import {
  claimBootstrap,
  logout,
  recoverSession,
  sessionInfo,
} from "./sessions.js";

// "restricted" permits setup/recovery sessions. Proof is required only for a
// signed-in user; enrollment through a one-use recovery link keeps its scope.
const routes = new Map([
  [
    "/auth/bootstrap/claim",
    { handler: claimBootstrap, session: "none", signIn: true },
  ],
  ["/auth/recover", { handler: recoverSession, session: "none", signIn: true }],
  [
    "/auth/login/options",
    { handler: authenticationOptions, session: "none", signIn: true },
  ],
  [
    "/auth/login/verify",
    { handler: verifyAuthentication, session: "none", signIn: true },
  ],
  ["/auth/reauth/options", { handler: authenticationOptions, session: "user" }],
  ["/auth/reauth/verify", { handler: verifyAuthentication, session: "user" }],
  ["/auth/logout", { handler: logout, session: "restricted" }],
  [
    "/auth/register/options",
    { handler: registrationOptions, session: "restricted", proof: true },
  ],
  [
    "/auth/register/verify",
    { handler: verifyRegistration, session: "restricted" },
  ],
  ["/auth/keys/delete", { handler: deleteKey, session: "user", proof: true }],
  ["/auth/keys/renew", { handler: renewKey, session: "user", proof: true }],
  [
    "/auth/recovery/new",
    { handler: replaceRecoveryCodes, session: "user", proof: true },
  ],
  [
    "/auth/apps/new",
    { handler: issueAppPassword, session: "user", proof: true },
  ],
  [
    "/auth/apps/renew",
    { handler: issueAppPassword, session: "user", proof: true },
  ],
  [
    "/auth/apps/revoke",
    { handler: revokeAppPassword, session: "user", proof: true },
  ],
  [
    "/auth/grants/revoke",
    { handler: revokeGrant, session: "user", proof: true },
  ],
]);

async function oauthProtocol(state, request, path) {
  if (request.method === "POST") {
    const ip = await sha256(request.headers.get("CF-Connecting-IP") || "local");
    await state.rate(`oauth:${ip}`, 60);
    if (path === "/oauth/register") {
      await state.rate(`register:${ip}`, 6);
      check(
        (await state.db.list({ prefix: "client:", limit: 256 })).keys.length <
          256,
        "clientLimit",
        429,
      );
    }
  }
  return state.server.fetch(request, state.oauthEnv, state.ctx);
}

// Called only inside AuthState's serialized operation boundary.
export async function routeAuth(state, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  check(url.origin === state.origin, "wrongAuthDomain", 403);
  if (request.method === "GET" && path === "/auth") return loginPage(request);
  if (request.method === "GET") {
    const asset = authAsset(path);
    if (asset) return asset;
  }
  // OAuth protocol endpoints own their CORS; browser mutations require Origin.
  if (path.startsWith("/oauth/") || path.startsWith("/.well-known/"))
    return oauthProtocol(state, request, path);
  if (request.method === "POST")
    check(request.headers.get("Origin") === state.origin, "crossOrigin", 403);
  const session = await state.session(request);
  if (path === "/authorize") return state.authorize(request, session);
  if (path === "/auth/session" && request.method === "GET")
    return sessionInfo(state, session);
  check(
    request.method === "POST" && path.startsWith("/auth/"),
    "endpointNotFound",
    404,
  );
  check(
    request.headers.get("Content-Type")?.startsWith("application/json"),
    "jsonRequired",
    415,
  );
  let body;
  try {
    body = await request.json();
  } catch {
    throw new AuthError("invalidJson");
  }
  check(
    body && typeof body === "object" && !Array.isArray(body),
    "invalidRequest",
  );
  const route = routes.get(path);
  // Keep unauthenticated unknown browser mutations behind the session boundary.
  if (!route) {
    state.requireSession(request, session, {
      restricted: path.startsWith("/auth/register/"),
    });
    throw new AuthError("endpointNotFound", 404);
  }
  if (route.signIn) {
    const ip = await sha256(request.headers.get("CF-Connecting-IP") || "local");
    await state.rate(`signin:${ip}`, 30);
    await state.rate("signin", 120);
  }
  if (route.session !== "none")
    state.requireSession(request, session, {
      restricted: route.session === "restricted",
    });
  let parentId = session?.keyId;
  if (route.proof && session.kind === "user")
    parentId = (
      await state.useProof(
        request.headers.get("X-Postlet-Proof"),
        session,
        path,
        body,
      )
    ).keyId;
  const headers = new Headers();
  const response = (value) => Response.json(value, { headers });
  return route.handler(state, {
    request,
    session,
    body,
    headers,
    response,
    path,
    parentId,
  });
}
