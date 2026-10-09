import { sha256 } from "../util.js";
import {
  active,
  COOKIE,
  check,
  cookie,
  now,
  random,
  setCookie,
} from "./policy.js";

export async function session(state, request) {
  const value = cookie(request, COOKIE);
  if (!value || !/^[\w-]{43}$/.test(value)) return null;
  const id = await sha256(value);
  const session = await state.get(`session:${id}`);
  if (
    session?.kind === "user" &&
    !active(await state.get(`key:${session.keyId}`))
  )
    return null;
  return session ? { ...session, id } : null;
}

export async function issueSession(state, kind, headers, old, keyId) {
  if (old) await state.del(`session:${old.id}`);
  const value = random(),
    id = await sha256(value),
    csrf = random();
  const ttl = kind === "user" ? 3600 : 600;
  await state.put(
    `session:${id}`,
    { kind, csrf, createdAt: now(), keyId },
    ttl,
  );
  headers.append("Set-Cookie", setCookie(COOKIE, value, ttl));
  return csrf;
}

export function requireSession(request, session, { restricted = false } = {}) {
  check(
    session && (restricted || session.kind === "user"),
    "signInRequired",
    401,
  );
  check(
    request.headers.get("X-Postlet-CSRF") === session.csrf,
    "pageExpired",
    403,
  );
}

export async function claimBootstrap(
  state,
  { session, body, headers, response },
) {
  check(
    typeof body.token === "string" && body.token.length === 43,
    "invalidSetupLink",
    401,
  );
  const pending = await state.get("bootstrap");
  check(
    (pending?.kind === "recovery" || !(await state.get("initialized"))) &&
      pending?.digest === (await sha256(body.token)),
    "setupLinkExpired",
    401,
  );
  await state.del("bootstrap");
  return response({
    csrf: await state.issueSession(
      pending.kind,
      headers,
      session,
      pending.parentId,
    ),
  });
}

export async function recoverSession(
  state,
  { session, body, headers, response },
) {
  await state.rate("recovery", 10, 3600);
  check(
    typeof body.code === "string" && body.code.length < 100,
    "invalidRecoveryCode",
    401,
  );
  const recovery = await state.consume(`recovery:${await sha256(body.code)}`);
  check(active(recovery), "recoveryCodeExpired", 401);
  return response({
    csrf: await state.issueSession("recovery", headers, session, recovery.id),
  });
}

export async function logout(state, { session, headers, response }) {
  await state.del(`session:${session.id}`);
  headers.append("Set-Cookie", setCookie(COOKIE, "", 0));
  return response({ ok: true });
}

export async function sessionInfo(state, session) {
  const result = {
    session: session ? { kind: session.kind } : null,
    csrf: session?.csrf,
  };
  if (session?.kind === "user") {
    result.keys = (await state.entries("key:")).map(
      ({ id, name, createdAt, lastUsedAt, expiresAt, parentId }) => ({
        id,
        name,
        createdAt,
        lastUsedAt,
        expiresAt,
        parentId,
      }),
    );
    result.grants = (
      await state.oauth.listUserGrants("owner", { limit: 1000 })
    ).items;
    result.apps = (await state.entries("app:")).map(
      ({ id, name, scopes, expiresAt, parentId }) => ({
        id,
        name,
        scopes,
        expiresAt,
        parentId,
      }),
    );
    result.recovery = await state.entries("recovery:");
  }
  return Response.json(result);
}
