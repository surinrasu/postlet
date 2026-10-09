import { sha256 } from "../util.js";
import {
  active,
  CREDENTIAL_TTL,
  check,
  label,
  lifetime,
  now,
  random,
  scopes,
} from "./policy.js";

export async function recoveryCodes(state, parentId) {
  await state.dropPrefix("recovery:");
  const codes = Array.from({ length: 8 }, () => `recovery_${random()}`);
  for (const code of codes) {
    const id = random();
    state.lineage(id, parentId);
    await state.put(
      `recovery:${await sha256(code)}`,
      { id, ...lifetime(parentId) },
      CREDENTIAL_TTL,
    );
  }
  return codes;
}

export async function descendants(state, id, cascade) {
  check(
    typeof id === "string" && /^[\w-]{1,2048}$/.test(id),
    "invalidCredentialId",
  );
  const ids = new Set([id]);
  if (cascade) {
    // Keep the ancestry even after a recovery code has been consumed or a
    // parent credential removed. Otherwise cascading revocation skips heirs.
    for (const row of state.db.sql.exec(
      "WITH RECURSIVE descendants(id) AS (SELECT ? UNION SELECT c.id FROM credential_lineage c JOIN descendants d ON c.parent_id=d.id) SELECT id FROM descendants",
      id,
    ))
      ids.add(row.id);
  }
  return ids;
}

export async function revokeCredentials(state, ids, cascade = false) {
  for (const prefix of ["key:", "app:", "recovery:"]) {
    for (const { name } of (await state.db.list({ prefix: `auth:${prefix}` }))
      .keys)
      if (ids.has((await state.db.get(name, { type: "json" }))?.id))
        await state.db.delete(name);
  }
  if (cascade)
    for (const grant of (
      await state.oauth.listUserGrants("owner", { limit: 1000 })
    ).items)
      if (ids.has(grant.metadata?.parentId))
        await state.oauth.revokeGrant(grant.id, "owner");
}

export async function deleteKey(state, { body, response }) {
  const keys = await state.entries("key:");
  const removed = await state.descendants(body.id, body.cascade === true);
  check(
    keys.some((key) => !removed.has(key.id) && active(key)),
    "lastPasskey",
  );
  check(
    keys.some((key) => key.id === body.id),
    "passkeyNotFound",
    404,
  );
  await state.revokeCredentials(removed, body.cascade === true);
  const sessions = await state.db.list({ prefix: "auth:session:" });
  for (const { name } of sessions.keys) {
    const current = await state.db.get(name, { type: "json" });
    if (removed.has(current?.keyId)) await state.db.delete(name);
  }
  return response({ ok: true });
}

export async function renewKey(state, { body, response, parentId }) {
  const key = await state.get(`key:${body.id}`);
  check(key, "passkeyNotFound", 404);
  await state.put(`key:${key.id}`, {
    ...key,
    expiresAt: lifetime(parentId).expiresAt,
    renewedAt: now(),
    renewedBy: parentId,
  });
  return response({ ok: true });
}

export async function issueAppPassword(
  state,
  { body, response, path, parentId },
) {
  let old;
  if (path === "/auth/apps/renew") {
    old = (await state.entries("app:")).find((app) => app.id === body.id);
    check(old, "appPasswordNotFound", 404);
  }
  check(old || (await state.entries("app:")).length < 32, "appPasswordLimit");
  const token = `pat_${random()}`,
    id = random();
  const value = {
    id,
    name: old?.name || label(body.name),
    scopes: old?.scopes || scopes(body.scopes),
    ...lifetime(parentId),
  };
  state.lineage(id, parentId);
  await state.put(`app:${await sha256(token)}`, value);
  if (old) await state.revokeCredentials(new Set([old.id]));
  return response({ ...value, token });
}

export async function revokeAppPassword(state, { body, response }) {
  check(
    (await state.entries("app:")).some((app) => app.id === body.id),
    "appPasswordNotFound",
    404,
  );
  await state.revokeCredentials(
    await state.descendants(body.id, body.cascade === true),
    body.cascade === true,
  );
  return response({ ok: true });
}

export async function replaceRecoveryCodes(state, { response, parentId }) {
  return response({ codes: await state.recoveryCodes(parentId) });
}
