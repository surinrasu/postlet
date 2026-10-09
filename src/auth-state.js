import { DurableObject } from "cloudflare:workers";
import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
} from "@cloudflare/workers-oauth-provider";
import { challenge, useProof } from "./auth/ceremonies.js";
import {
  descendants,
  recoveryCodes,
  revokeCredentials,
} from "./auth/credentials.js";
import { authorize } from "./auth/oauth.js";
import {
  AuthError,
  active,
  check,
  now,
  random,
  SCOPES,
} from "./auth/policy.js";
import { routeAuth } from "./auth/routes.js";
import { issueSession, requireSession, session } from "./auth/sessions.js";
import { errorMessage } from "./auth-i18n.js";
import { AuthStorage } from "./auth-storage.js";
import { logEvent, withRequestId } from "./observability.js";
import { sha256 } from "./util.js";

// Serialize the complete protocol operation, including cryptographic awaits.
// The provider's KV interface uses this same SQLite database, so concurrent code
// exchange, challenge consumption, token rotation and revocation cannot race.
export class AuthState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = new AuthStorage(ctx.storage.sql);
    this.origin = new URL(env.PUBLIC_URL || "https://localhost:8787").origin;
    this.rpID = new URL(this.origin).hostname;
    this.oauthEnv = { ...env, OAUTH_KV: this.db };
    this.server = new OAuthAuthorizationServer({
      issuer: this.origin,
      resources: [`${this.origin}/mcp`, `${this.origin}/jmap`],
      defaultResource: `${this.origin}/mcp`,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      allowTokenExchangeGrant: false,
      scopesSupported: SCOPES,
      accessTokenTTL: 900,
      refreshTokenTTL: 14 * 86400,
      tokenExchangeCallback: async ({ scope }) => ({
        refreshTokenTTL: scope.includes("offline_access") ? 14 * 86400 : 0,
      }),
      // Client-controlled error descriptions may contain sensitive request data.
      onError: () => undefined,
    });
    this.oauth = this.server.getOAuthApi(this.oauthEnv);
  }
  get(name) {
    return this.db.get(`auth:${name}`, { type: "json" });
  }
  put(name, value, ttl) {
    return this.db.put(
      `auth:${name}`,
      JSON.stringify(value),
      ttl ? { expirationTtl: ttl } : {},
    );
  }
  del(name) {
    return this.db.delete(`auth:${name}`);
  }
  async entries(prefix) {
    const rows = await this.db.list({ prefix: `auth:${prefix}`, limit: 1000 });
    return (
      await Promise.all(
        rows.keys.map((r) => this.db.get(r.name, { type: "json" })),
      )
    ).filter(Boolean);
  }
  async dropPrefix(prefix) {
    const rows = await this.db.list({ prefix: `auth:${prefix}`, limit: 1000 });
    for (const row of rows.keys) await this.db.delete(row.name);
  }
  lineage(id, parentId) {
    this.db.sql.exec(
      "INSERT INTO credential_lineage(id,parent_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id",
      id,
      parentId,
    );
  }
  async consume(name) {
    const value = await this.get(name);
    await this.del(name);
    return value;
  }
  async rate(key, limit, seconds = 60) {
    const name = `rate:${key}:${Math.floor(now() / (seconds * 1000))}`;
    const count = (await this.get(name)) || 0;
    check(count < limit, "rateLimited", 429);
    await this.put(name, count + 1, seconds * 2);
  }
  session(request) {
    return session(this, request);
  }
  issueSession(kind, headers, old, keyId) {
    return issueSession(this, kind, headers, old, keyId);
  }
  requireSession(request, session, options = {}) {
    return requireSession(request, session, options);
  }
  async createBootstrap() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.get("initialized"))
        return {
          error:
            "A passkey is already configured. Sign in or use a recovery code.",
        };
      const token = random();
      await this.put(
        "bootstrap",
        {
          digest: await sha256(token),
          kind: "bootstrap",
          parentId: "bootstrap:owner",
        },
        600,
      );
      return { url: `${this.origin}/auth#setup=${token}`, expiresIn: 600 };
    });
  }
  async createRecovery(digest) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.get(`admin-used:${digest}`))
        return {
          error:
            "The administrative recovery credential has already been used.",
        };
      await this.put(`admin-used:${digest}`, true);
      const token = random();
      await this.put(
        "bootstrap",
        {
          digest: await sha256(token),
          kind: "recovery",
          parentId: "cloudflare-admin",
        },
        600,
      );
      return { url: `${this.origin}/auth#setup=${token}`, expiresIn: 600 };
    });
  }
  async validate(token, resource) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (token.startsWith("pat_")) {
        const app = await this.get(`app:${await sha256(token)}`);
        return active(app) ? { id: `app:${app.id}`, scopes: app.scopes } : null;
      }
      try {
        const result = await this.server.validateToken(
          resource,
          token,
          this.oauthEnv,
        );
        return result?.userId === "owner"
          ? {
              id: `oauth:${result.clientId}`,
              scopes: result.scope.filter((s) =>
                SCOPES.slice(0, 3).includes(s),
              ),
            }
          : (await this.get("initialized"))
            ? null
            : { id: "", scopes: [], legacyAllowed: true };
      } catch {
        return (await this.get("initialized"))
          ? null
          : { id: "", scopes: [], legacyAllowed: true };
      }
    });
  }
  async maintenance() {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.db.clean();
      await this.server.purgeExpiredData(this.oauthEnv);
    });
  }
  async fetch(request) {
    return withRequestId(
      request.headers.get("X-Postlet-Request-ID") || crypto.randomUUID(),
      () =>
        this.ctx.blockConcurrencyWhile(async () => {
          try {
            this.db.clean();
            return await this.route(request);
          } catch (error) {
            if (error instanceof AuthError)
              return Response.json(
                { error: errorMessage(error.message, request) },
                { status: error.status },
              );
            if (
              error instanceof AuthorizationError ||
              error instanceof CimdFetchError
            )
              return Response.json(
                {
                  error: errorMessage("authorizationRequestExpired", request),
                },
                { status: 400 },
              );
            // Never log request bodies, ceremony responses, cookies or OAuth tokens.
            logEvent("authentication_failed", { stage: "auth_route" }, error);
            return Response.json(
              { error: errorMessage("authenticationUnavailable", request) },
              { status: 500 },
            );
          }
        }),
    );
  }
  route(request) {
    return routeAuth(this, request);
  }
  challenge(id, type) {
    return challenge(this, id, type);
  }
  recoveryCodes(parentId) {
    return recoveryCodes(this, parentId);
  }
  useProof(value, session, action, payload) {
    return useProof(this, value, session, action, payload);
  }
  descendants(id, cascade) {
    return descendants(this, id, cascade);
  }
  revokeCredentials(ids, cascade = false) {
    return revokeCredentials(this, ids, cascade);
  }
  authorize(request, session) {
    return authorize(this, request, session);
  }
}
