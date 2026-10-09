import { authenticate, unauthorized } from "./auth.js";
import { MAX_API_BYTES, maxMessageBytes, session } from "./config.js";
import { assert, errorJSON, JmapError } from "./errors.js";
import { validateRequest } from "./jmap.js";
import { handleMcp } from "./mcp.js";
import { blobId } from "./mime.js";
import { logEvent, withRequestId } from "./observability.js";
import { encoder, isObject, readLimited, sha256, validId } from "./util.js";

export { MailAccount } from "./account.js";
export { AuthState } from "./auth-state.js";

function account(env) {
  return env.ACCOUNT.getByName(env.ACCOUNT_ID || "personal");
}

/** @param {Response} response */
function secure(response) {
  const copy = new Response(response.body, response);
  copy.headers.set("Cache-Control", "no-store");
  copy.headers.set("X-Content-Type-Options", "nosniff");
  if (!copy.headers.has("Referrer-Policy"))
    copy.headers.set("Referrer-Policy", "no-referrer");
  if (!copy.headers.has("Content-Security-Policy"))
    copy.headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return copy;
}

async function fetchHandler(request, env, requestId) {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET")
    return Response.json({
      service: "postlet",
      status: "ok",
      version: "0.1.0",
    });
  const canonical = new URL(env.PUBLIC_URL || "https://localhost:8787").origin;
  if (url.pathname === "/auth/admin-recovery" && request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== canonical)
      return new Response(null, { status: 403 });
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (
      !token ||
      token.length !== 43 ||
      !env.PASSKEY_RECOVERY_SHA256 ||
      (await sha256(token)) !== env.PASSKEY_RECOVERY_SHA256
    )
      return unauthorized(request, env);
    const result = await env.AUTH.getByName("owner").createRecovery(
      env.PASSKEY_RECOVERY_SHA256,
    );
    return Response.json(result, { status: result.error ? 409 : 200 });
  }
  const resourceMetadata =
    /^\/\.well-known\/oauth-protected-resource\/(mcp|jmap)$/.exec(url.pathname);
  if (resourceMetadata && request.method === "GET")
    return Response.json(
      {
        resource: `${canonical}/${resourceMetadata[1]}`,
        authorization_servers: [canonical],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
        resource_name: "Postlet",
      },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  if (url.pathname === "/auth/bootstrap" && request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== canonical)
      return new Response(null, { status: 403 });
    const owner = await authenticate(request, env, { staticOnly: true });
    if (
      owner?.id !== "owner" ||
      !["read", "write", "send"].every((s) => owner.scopes.includes(s))
    )
      return unauthorized(request, env);
    const result = await env.AUTH.getByName("owner").createBootstrap();
    return Response.json(result, { status: result.error ? 409 : 200 });
  }
  if (
    url.pathname === "/auth" ||
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/authorize" ||
    url.pathname.startsWith("/oauth/") ||
    url.pathname.startsWith("/.well-known/oauth-authorization-server")
  ) {
    if (url.origin !== canonical) {
      if (request.method === "GET")
        return Response.redirect(
          `${canonical}${url.pathname}${url.search}`,
          302,
        );
      return new Response(null, { status: 403 });
    }
    // Buffer a bounded body before entering the serialized authentication DO.
    const body = request.body ? await readLimited(request.body, 65536) : null;
    const headers = new Headers(request.headers);
    headers.set("X-Postlet-Request-ID", requestId);
    return env.AUTH.getByName("owner").fetch(
      new Request(request, { headers, ...(body ? { body } : {}) }),
    );
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin)
    return Response.json({ error: "originNotAllowed" }, { status: 403 });
  const auth = await authenticate(request, env);
  if (!auth) return unauthorized(request, env);
  auth.requestId = requestId;
  if (!auth.scopes.includes("read"))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const stub = account(env);
  if (url.pathname === "/admin/status" && request.method === "GET")
    return Response.json(await stub.status());
  if (
    ["/admin/inbound/retry", "/admin/storage"].includes(url.pathname) &&
    request.method === "POST"
  ) {
    if (!auth.scopes.includes("write"))
      return Response.json({ error: "forbidden" }, { status: 403 });
    let input;
    try {
      input = JSON.parse(
        new TextDecoder().decode(await readLimited(request.body, 65536)),
      );
    } catch (error) {
      if (error instanceof JmapError) throw error;
      throw new JmapError("invalidArguments", "Expected JSON.");
    }
    assert(isObject(input));
    if (url.pathname === "/admin/inbound/retry") {
      // Validate before RPC: custom Error subclasses do not retain their
      // prototype across the DO boundary, so malformed input must fail here.
      assert(
        Array.isArray(input.ids) &&
          input.ids.length > 0 &&
          input.ids.length <= 100 &&
          input.ids.every(validId),
      );
      return Response.json(await stub.retryIncoming(input.ids));
    }
    assert(input.apply == null || typeof input.apply === "boolean");
    return Response.json(await stub.collectStorage(input.apply === true));
  }
  if (
    ["/.well-known/jmap", "/jmap/session"].includes(url.pathname) &&
    request.method === "GET"
  )
    return Response.json(
      session(env, env.PUBLIC_URL || url.origin, auth.scopes),
    );
  if (url.pathname === "/mcp") return handleMcp(request, stub, env, auth);
  if (url.pathname === "/jmap" && request.method === "POST") {
    if (
      !request.headers
        .get("Content-Type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return Response.json(
        { type: "urn:ietf:params:jmap:error:notJSON", status: 415 },
        { status: 415 },
      );
    const bytes = await readLimited(request.body, MAX_API_BYTES);
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return Response.json(
        { type: "urn:ietf:params:jmap:error:notJSON", status: 400 },
        { status: 400 },
      );
    }
    validateRequest(input);
    return Response.json(await stub.execute(input, auth));
  }
  const upload = /^\/jmap\/upload\/([^/]+)$/.exec(url.pathname);
  if (upload && request.method === "POST") {
    if (upload[1] !== (env.ACCOUNT_ID || "personal"))
      return Response.json({ error: "accountNotFound" }, { status: 404 });
    if (!auth.scopes.includes("write"))
      return Response.json({ error: "forbidden" }, { status: 403 });
    const bytes = await readLimited(request.body, maxMessageBytes(env));
    const type =
      request.headers.get("Content-Type") || "application/octet-stream";
    return Response.json(
      {
        accountId: env.ACCOUNT_ID || "personal",
        ...(await stub.upload(bytes, type)),
      },
      { status: 201 },
    );
  }
  const download = /^\/jmap\/download\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
    url.pathname,
  );
  if (download && ["GET", "HEAD"].includes(request.method)) {
    if (
      download[1] !== (env.ACCOUNT_ID || "personal") ||
      !validId(download[2]) ||
      !(await stub.blobInfo(download[2]))
    )
      return new Response(null, { status: 404 });
    const object = await env.MAIL.get(`blobs/${download[2]}`);
    if (!object) return new Response(null, { status: 404 });
    const type =
      url.searchParams.get("type") ||
      object.httpMetadata?.contentType ||
      "application/octet-stream";
    const safeType =
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$/i.test(type)
        ? type
        : "application/octet-stream";
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": safeType,
        "Content-Length": String(object.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(decodeURIComponent(download[3])).replaceAll("'", "%27")}`,
      },
    });
  }
  if (url.pathname === "/jmap/events" && request.method === "GET")
    return stub.events(
      url.searchParams.get("types") || "*",
      url.searchParams.get("closeafter") || "no",
      url.searchParams.get("ping"),
    );
  return Response.json({ error: "notFound" }, { status: 404 });
}

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    return withRequestId(requestId, async () => {
      let response;
      try {
        response = secure(await fetchHandler(request, env, requestId));
      } catch (error) {
        const body = errorJSON(error);
        const status =
          error instanceof JmapError
            ? error.type === "tooLarge"
              ? 413
              : 400
            : 500;
        response = secure(
          Response.json(
            {
              ...body,
              type: `urn:ietf:params:jmap:error:${body.type}`,
              status,
            },
            { status },
          ),
        );
      }
      response.headers.set("X-Request-ID", requestId);
      return response;
    });
  },

  /** @param {ForwardableEmailMessage} message @param {Env} env */
  async email(message, env) {
    if (
      !message.to.toLowerCase().endsWith(`@${env.MAIL_DOMAIN.toLowerCase()}`)
    ) {
      message.setReject("Recipient domain is not configured.");
      return;
    }
    if (message.rawSize > maxMessageBytes(env)) {
      message.setReject("Message exceeds the configured size limit.");
      return;
    }
    const raw = await readLimited(message.raw, maxMessageBytes(env));
    const rawId = await blobId(raw);
    const id = `r${await sha256(`${rawId}:${message.to.toLowerCase()}`)}`;
    const ticket = {
      id,
      blobId: rawId,
      rawKey: `incoming-raw/${id}`,
      size: raw.byteLength,
      createdAt: Date.now(),
      envelope: { from: message.from, to: message.to },
    };
    // Both writes are awaited before acknowledging the email event. Hourly
    // maintenance can discover the ticket even if the following RPC fails.
    await env.MAIL.put(ticket.rawKey, raw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
    await env.MAIL.put(
      `incoming/${id}`,
      encoder.encode(JSON.stringify(ticket)),
      { httpMetadata: { contentType: "application/json" } },
    );
    await account(env).enqueueIncoming(ticket);
  },

  /** @param {ScheduledController} _event @param {Env} env */
  async scheduled(_event, env) {
    const jobs = [account(env).maintenance()];
    if (env.AUTH) jobs.push(env.AUTH.getByName("owner").maintenance());
    const results = await Promise.allSettled(jobs);
    for (const [index, result] of results.entries())
      if (result.status === "rejected") {
        logEvent(
          "maintenance_failed",
          { stage: index === 0 ? "mailbox" : "authentication" },
          result.reason,
        );
      }
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Maintenance failed; inspect structured logs.");
  },
};
