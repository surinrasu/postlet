import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { sha256 } from "../util.js";
import {
  AuthError,
  active,
  CEREMONY,
  COOKIE,
  check,
  cookie,
  label,
  lifetime,
  MUTATIONS,
  now,
  random,
  setCookie,
} from "./policy.js";

export async function challenge(state, id, type) {
  check(
    typeof id === "string" && /^[\w-]{43}$/.test(id),
    "invalidVerificationRequest",
  );
  const challenge = await state.consume(`challenge:${id}`);
  check(challenge?.type === type, "challengeExpired", 401);
  return challenge;
}

export async function useProof(state, value, session, action, payload) {
  check(
    typeof value === "string" && /^[\w-]{43}$/.test(value),
    "reauthenticationRequired",
    403,
  );
  const proof = await state.consume(`proof:${await sha256(value)}`);
  check(
    proof?.sessionId === session.id &&
      proof.action === action &&
      proof.payloadHash === (await sha256(JSON.stringify(payload))) &&
      active(await state.get(`key:${proof.keyId}`)),
    "proofMismatch",
    403,
  );
  return proof;
}

export async function authenticationOptions(
  state,
  { session, body, headers, response, path },
) {
  const reauth = path === "/auth/reauth/options";
  if (reauth) {
    check(
      MUTATIONS.includes(body.action) &&
        body.payload &&
        typeof body.payload === "object",
      "invalidVerificationOperation",
    );
    await state.rate(`reauth:${session.id}`, 30);
  }
  const options = await generateAuthenticationOptions({
    rpID: state.rpID,
    userVerification: "required",
  });
  const id = random(),
    binding = random();
  await state.put(
    `challenge:${id}`,
    {
      challenge: options.challenge,
      binding: await sha256(binding),
      type: reauth ? "reauth" : "login",
      ...(reauth
        ? {
            sessionId: session.id,
            action: body.action,
            payloadHash: await sha256(JSON.stringify(body.payload)),
          }
        : {}),
    },
    300,
  );
  headers.append("Set-Cookie", setCookie(CEREMONY, binding, 300));
  return response({ id, options });
}

export async function verifyAuthentication(
  state,
  { request, session, body, headers, response, path },
) {
  const reauth = path === "/auth/reauth/verify";
  const challenge = await state.challenge(body.id, reauth ? "reauth" : "login");
  if (reauth)
    check(
      challenge.sessionId === session.id,
      "verificationSessionMismatch",
      403,
    );
  const binding = cookie(request, CEREMONY);
  check(
    binding && challenge.binding === (await sha256(binding)),
    "loginBrowserMismatch",
    403,
  );
  const key = await state.get(`key:${body.response?.id}`);
  check(active(key), "passkeyExpired", 401);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: state.origin,
      expectedRPID: state.rpID,
      requireUserVerification: true,
      credential: {
        id: key.id,
        publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")),
        counter: key.counter,
        transports: key.transports,
      },
    });
  } catch {
    throw new AuthError("passkeyVerificationRetry", 401);
  }
  check(verified.verified, "passkeyVerificationFailed", 401);
  await state.put(`key:${key.id}`, {
    ...key,
    counter: verified.authenticationInfo.newCounter,
    lastUsedAt: now(),
  });
  headers.append("Set-Cookie", setCookie(CEREMONY, "", 0));
  if (reauth) {
    const proof = random();
    await state.put(
      `proof:${await sha256(proof)}`,
      {
        sessionId: session.id,
        action: challenge.action,
        payloadHash: challenge.payloadHash,
        keyId: key.id,
      },
      60,
    );
    return response({ proof });
  }
  return response({
    csrf: await state.issueSession("user", headers, session, key.id),
  });
}

export async function registrationOptions(
  state,
  { session, body, response, parentId },
) {
  const keys = await state.entries("key:");
  check(keys.length < 10 || session.kind === "recovery", "passkeyLimit");
  check(
    session.kind !== "bootstrap" || !(await state.get("initialized")),
    "setupCompleted",
    403,
  );
  const name = label(body.name);
  let userId = await state.get("userId");
  if (!userId) {
    userId = random();
    await state.put("userId", userId);
  }
  const options = await generateRegistrationOptions({
    rpName: "Postlet",
    rpID: state.rpID,
    userName: state.env.MAIL_ADDRESS,
    userID: new Uint8Array(Buffer.from(userId, "base64url")),
    attestationType: "none",
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: keys.map(({ id, transports }) => ({
      id,
      transports,
    })),
  });
  const id = random();
  await state.put(
    `challenge:${id}`,
    {
      type: "register",
      challenge: options.challenge,
      sessionId: session.id,
      name,
      parentId,
    },
    300,
  );
  return response({ id, options });
}

export async function verifyRegistration(
  state,
  { session, body, headers, response },
) {
  const challenge = await state.challenge(body.id, "register");
  check(challenge.sessionId === session.id, "registrationSessionMismatch", 403);
  check(
    (await state.entries("key:")).length < 10 || session.kind === "recovery",
    "passkeyLimit",
  );
  const initialized = await state.get("initialized");
  if (session.kind === "user")
    check(
      active(await state.get(`key:${challenge.parentId}`)),
      "issuerExpired",
      401,
    );
  check(session.kind !== "bootstrap" || !initialized, "setupCompleted", 403);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: state.origin,
      expectedRPID: state.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch {
    throw new AuthError("passkeyRegistrationFailed", 401);
  }
  check(
    verified.verified && verified.registrationInfo,
    "passkeyNotVerified",
    401,
  );
  const key = verified.registrationInfo.credential;
  check(!(await state.get(`key:${key.id}`)), "passkeyAlreadyRegistered");
  state.lineage(key.id, challenge.parentId);
  await state.put(`key:${key.id}`, {
    id: key.id,
    name: challenge.name,
    publicKey: Buffer.from(key.publicKey).toString("base64url"),
    counter: key.counter,
    transports: key.transports,
    ...lifetime(challenge.parentId),
  });
  await state.put("initialized", true);
  const recoveryCodes =
    initialized || session.kind === "recovery"
      ? undefined
      : await state.recoveryCodes(key.id);
  if (session.kind === "recovery") {
    await state.del(`session:${session.id}`);
    headers.append("Set-Cookie", setCookie(COOKIE, "", 0));
    return response({ requiresLogin: true });
  }
  return response({
    recoveryCodes,
    csrf: await state.issueSession("user", headers, session, key.id),
  });
}
