import { consentPage } from "../passkey-ui.js";
import { sha256 } from "../util.js";
import { check, scopes } from "./policy.js";

export async function authorize(state, request, session) {
  if (request.method === "GET") {
    await state.rate(
      `authorize:${await sha256(request.headers.get("CF-Connecting-IP") || "local")}`,
      20,
    );
    const parsed = await state.oauth.parseAuthRequest(request);
    check(
      parsed.codeChallenge && parsed.codeChallengeMethod === "S256",
      "pkceRequired",
    );
    if (session?.kind !== "user") {
      const url = new URL(request.url);
      return Response.redirect(
        `${state.origin}/auth?next=${encodeURIComponent(url.pathname + url.search)}`,
        302,
      );
    }
    const details = await state.oauth.describeConsent(parsed);
    const consent = await state.oauth.beginConsent(parsed);
    // In addition to the library's browser binding, bind consent to this login.
    await state.put(
      `consent:${await sha256(consent.handle)}`,
      { sessionId: session.id },
      600,
    );
    return consentPage(request, details, consent.handle, consent.headers);
  }
  check(request.method === "POST", "methodNotAllowed", 405);
  check(session?.kind === "user", "signInRequired", 401);
  const form = await request.formData(),
    handle = form.get("handle");
  check(
    typeof handle === "string" && handle.length < 1024,
    "invalidAuthorizationRequest",
  );
  const binding = await state.consume(`consent:${await sha256(handle)}`);
  check(binding?.sessionId === session.id, "authorizationPageExpired", 403);
  if (form.get("decision") !== "approve") {
    const denied = await state.oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await state.oauth.approveConsent(request, handle, {
    scope: scopes(form.getAll("scope"), true),
  });
  const proof = await state.useProof(form.get("proof"), session, "/authorize", {
    handle,
    decision: "approve",
    scope: form.getAll("scope"),
  });
  const details = await state.oauth.describeConsent(approved.request);
  const { redirectTo } = await state.oauth.completeAuthorization({
    request: approved.request,
    userId: "owner",
    metadata: { clientName: details.clientName, parentId: proof.keyId },
    scope: approved.request.scope,
    props: { userId: "owner" },
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

export async function revokeGrant(state, { body, response }) {
  if (body.all === true) {
    // Iterate until no grants remain; listUserGrants limits may span pages.
    while (true) {
      const grants = (
        await state.oauth.listUserGrants("owner", { limit: 1000 })
      ).items;
      if (!grants.length) break;
      for (const grant of grants)
        await state.oauth.revokeGrant(grant.id, "owner");
    }
  } else {
    check(
      typeof body.id === "string" && /^[\w-]{1,255}$/.test(body.id),
      "invalidGrantId",
    );
    await state.oauth.revokeGrant(body.id, "owner");
  }
  return response({ ok: true });
}
