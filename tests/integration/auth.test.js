import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import { sha256 } from "../../src/util.js";
import {
  adminRecovery,
  createAuthHarness,
  createRegisteredOwner,
  owner,
  reader,
} from "../helpers/auth.js";

let browser, harness;
let mf, page, cdp, authenticatorId, directory, root, callbackRoot;
let fetch, post, session, proof, protectedPost, login, register;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
  });
});
beforeEach(async () => {
  harness = await createAuthHarness(browser);
  ({
    mf,
    page,
    cdp,
    authenticatorId,
    directory,
    root,
    callbackRoot,
    fetch,
    post,
    session,
    proof,
    protectedPost,
    login,
    register,
  } = harness);
}, 30000);
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});
afterAll(async () => {
  await browser?.close();
});

test("publishes OAuth discovery without exposing mailbox or accepting browser cookies as API credentials", async () => {
  const response = await fetch(`${root}/mcp`);
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toContain(
    "oauth-protected-resource/mcp",
  );
  const metadata = await (
    await fetch(`${root}/.well-known/oauth-authorization-server`)
  ).json();
  expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  expect(metadata.authorization_endpoint).toBe(`${root}/authorize`);
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  expect(
    (
      await (
        await fetch(`${root}/.well-known/oauth-protected-resource/mcp`)
      ).json()
    ).scopes_supported,
  ).toEqual(["read"]);
});

test("requires owner bootstrap, consumes setup link once and registers a real WebAuthn credential in Chrome", async () => {
  for (const token of [null, reader]) {
    expect(
      (
        await fetch(`${root}/auth/bootstrap`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
      ).status,
    ).toBe(401);
  }
  const response = await fetch(`${root}/auth/bootstrap`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner}` },
  });
  expect(response.status).toBe(200);
  const setup = await response.json();
  await page.goto(setup.url);
  await page.waitForFunction(
    () => !document.getElementById("registration").hidden,
  );
  const setupToken = new URLSearchParams(new URL(setup.url).hash.slice(1)).get(
    "setup",
  );
  expect(
    (await post("/auth/bootstrap/claim", { token: setupToken })).status,
  ).toBe(401);
  expect(
    (await post("/auth/apps/new", { name: "forbidden", scopes: ["read"] }))
      .status,
  ).toBe(401);
  const result = await register();
  const recoveryCodes = result.recoveryCodes;
  expect(recoveryCodes).toHaveLength(8);
  expect((await session()).keys).toHaveLength(1);
  expect(
    Date.parse((await session()).keys[0].expiresAt) - Date.now(),
  ).toBeGreaterThan(89 * 86400000);
  expect(
    (
      await fetch(`${root}/jmap/session`, {
        headers: { Authorization: `Bearer ${owner}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
      .credentials,
  ).toHaveLength(1);
  expect(
    (
      await fetch(`${root}/auth/bootstrap`, {
        method: "POST",
        headers: { Authorization: `Bearer ${owner}` },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await protectedPost("/auth/keys/delete", {
        id: (await session()).keys[0].id,
      })
    ).status,
  ).toBe(400);
  expect(
    await page.evaluate(async () => (await fetch("/jmap/session")).status),
  ).toBe(401);
  await page.screenshot({ path: "/tmp/postlet-passkey-management.png" });
});

test("enforces Origin and CSRF; creates a scoped application password whose revocation is immediate", async () => {
  await createRegisteredOwner(harness);
  expect(
    (
      await post(
        "/auth/apps/new",
        { name: "CSRF", scopes: ["read"] },
        { noCSRF: true },
      )
    ).status,
  ).toBe(403);
  const cookies = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  expect(
    (
      await fetch(`${root}/auth/apps/new`, {
        method: "POST",
        headers: {
          Cookie: cookies,
          Origin: "https://evil.example",
          "Content-Type": "application/json",
          "X-Postlet-CSRF": (await session()).csrf,
        },
        body: JSON.stringify({ name: "CSRF", scopes: ["read"] }),
      })
    ).status,
  ).toBe(403);
  const created = await protectedPost("/auth/apps/new", {
    name: "Himalaya test",
    scopes: ["read"],
  });
  expect(created.status).toBe(200);
  const appToken = created.data.token;
  const headers = {
    Authorization: `Basic ${Buffer.from(`root@example.test:${appToken}`).toString("base64")}`,
  };
  const jmap = await fetch(`${root}/.well-known/jmap`, { headers });
  expect(jmap.status).toBe(200);
  expect((await jmap.json()).accounts.personal.isReadOnly).toBe(true);
  expect(
    (
      await fetch(`${root}/jmap/upload/personal`, {
        method: "POST",
        headers,
        body: "forbidden",
      })
    ).status,
  ).toBe(403);
  expect(
    (await protectedPost("/auth/apps/revoke", { id: created.data.id })).status,
  ).toBe(200);
  expect((await fetch(`${root}/.well-known/jmap`, { headers })).status).toBe(
    401,
  );
});

test("every credential mutation keeps its session, CSRF and fresh-proof requirements", async () => {
  const mutations = [
    "/auth/register/options",
    "/auth/keys/renew",
    "/auth/keys/delete",
    "/auth/recovery/new",
    "/auth/apps/new",
    "/auth/apps/renew",
    "/auth/apps/revoke",
    "/auth/grants/revoke",
  ];
  await page.goto(`${root}/auth`);
  for (const path of mutations)
    expect((await post(path, {})).status, path).toBe(401);
  await createRegisteredOwner(harness);
  for (const path of mutations) {
    expect((await post(path, {}, { noCSRF: true })).status, path).toBe(403);
    expect((await post(path, {})).status, path).toBe(403);
  }
  for (const path of [
    "/auth/register/verify",
    "/auth/reauth/options",
    "/auth/reauth/verify",
    "/auth/logout",
  ])
    expect((await post(path, {}, { noCSRF: true })).status, path).toBe(403);
});

test("management requires a new operation-bound proof; app rotation invalidates the old password", async () => {
  await createRegisteredOwner(harness);
  const payload = { name: "Rotation test", scopes: ["read"] };
  expect((await post("/auth/apps/new", payload)).status).toBe(403);
  const oneUse = await proof("/auth/apps/new", payload);
  const created = await post("/auth/apps/new", payload, { proof: oneUse });
  expect(created.status).toBe(200);
  expect(
    (await post("/auth/apps/new", payload, { proof: oneUse })).status,
  ).toBe(403);
  const bound = await proof("/auth/apps/new", payload);
  expect(
    (
      await post(
        "/auth/apps/new",
        { ...payload, scopes: ["read", "write", "send"] },
        { proof: bound },
      )
    ).status,
  ).toBe(403);
  const rotated = await protectedPost("/auth/apps/renew", {
    id: created.data.id,
  });
  expect(rotated.status).toBe(200);
  expect(rotated.data.token).not.toBe(created.data.token);
  expect(
    (
      await fetch(`${root}/jmap/session`, {
        headers: { Authorization: `Bearer ${created.data.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${root}/jmap/session`, {
        headers: { Authorization: `Bearer ${rotated.data.token}` },
      })
    ).status,
  ).toBe(200);
  const key = (await session()).keys[0];
  expect(
    (await protectedPost("/auth/apps/revoke", { id: key.id })).status,
  ).toBe(404);
  const renewed = await protectedPost("/auth/keys/renew", { id: key.id });
  expect(renewed.status).toBe(200);
  expect(
    Date.parse((await session()).keys[0].expiresAt),
  ).toBeGreaterThanOrEqual(Date.parse(key.expiresAt));
});

test.runIf(process.env.POSTLET_TEST_HIMALAYA === "1")(
  "Himalaya accepts a Passkey-issued application password and its revocation",
  async () => {
    await createRegisteredOwner(harness);
    const application = await protectedPost("/auth/apps/new", {
      name: "Himalaya",
      scopes: ["read"],
    });
    expect(application.status).toBe(200);
    const cert = await new Promise((resolve, reject) => {
      // Trust only the certificate returned by this isolated localhost runtime.
      const socket = tlsConnect(
        {
          host: "127.0.0.1",
          port: Number(new URL(root).port),
          rejectUnauthorized: false,
        },
        () => {
          const cert = socket.getPeerCertificate().raw;
          socket.end();
          resolve(cert);
        },
      );
      socket.on("error", reject);
    });
    const certPath = join(directory, "localhost.pem"),
      configPath = join(directory, "himalaya.toml"),
      tokenPath = join(directory, "himalaya.token");
    await writeFile(
      certPath,
      `-----BEGIN CERTIFICATE-----\n${Buffer.from(cert)
        .toString("base64")
        .match(/.{1,64}/g)
        .join("\n")}\n-----END CERTIFICATE-----\n`,
      { mode: 0o600 },
    );
    await writeFile(tokenPath, application.data.token, { mode: 0o600 });
    await writeFile(
      configPath,
      `[accounts.postlet]\ndefault=true\nemail="root@example.test"\njmap.server=${JSON.stringify(`${root}/.well-known/jmap`)}\njmap.tls.cert=${JSON.stringify(certPath)}\njmap.auth.basic.username="root@example.test"\njmap.auth.basic.password.command=${JSON.stringify(["cat", tokenPath])}\n`,
      { mode: 0o600 },
    );
    const exec = promisify(execFile);
    const args = [
      "--config",
      configPath,
      "--log-level",
      "off",
      "--json",
      "mailbox",
      "list",
    ];
    expect((await exec("himalaya", args)).stdout).toContain("Inbox");
    expect(
      (await protectedPost("/auth/apps/revoke", { id: application.data.id }))
        .status,
    ).toBe(200);
    await expect(exec("himalaya", args)).rejects.toThrow();
  },
);

test("logs in with a signed assertion, rejects its replay and validates user presence", async () => {
  await createRegisteredOwner(harness);
  await post("/auth/logout", {});
  let assertion;
  const capture = async (route) => {
    assertion = route.request().postDataJSON();
    await route.continue();
  };
  await page.route("**/auth/login/verify", capture);
  await login();
  await page.unroute("**/auth/login/verify", capture);
  expect((await post("/auth/login/verify", assertion)).status).toBe(401);
  await cdp.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: false,
  });
  const rejected = await page.evaluate(async () => {
    const start = await (
      await fetch("/auth/login/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    const assertion = await window.SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: { ...start.options, userVerification: "discouraged" },
    });
    const response = await fetch("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: start.id, response: assertion }),
    });
    return response.status === 401;
  });
  expect(rejected).toBe(true);
  await cdp.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: true,
  });
});

test("OAuth PKCE code exchange, audience isolation, refresh rotation, consent binding and revocation", async () => {
  await createRegisteredOwner(harness);
  const clientResponse = await fetch(`${root}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test <script>bad()</script>",
      redirect_uris: [`${callbackRoot}/callback`],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(clientResponse.status).toBe(201);
  const client = await clientResponse.json();
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${root}/mcp`,
    scope: "read offline_access",
    state: "test-state",
  });
  await page.goto(`${root}/authorize?${params}`);
  expect(await page.locator("strong").first().textContent()).toBe(
    "Test <script>bad()</script>",
  );
  const handle = await page.locator('input[name="handle"]').inputValue();
  // A second browser does not have the library's cookie or this login session.
  expect(
    (
      await fetch(`${root}/authorize`, {
        method: "POST",
        headers: {
          Origin: root,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          handle,
          decision: "approve",
          scope: "read",
        }),
        redirect: "manual",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  const approvalResponse = page.waitForResponse(
    (r) => r.url() === `${root}/authorize` && r.request().method() === "POST",
  );
  await page
    .locator('#consent button[value="approve"]')
    .click({ noWaitAfter: true, timeout: 3000 });
  const approval = await approvalResponse;
  if (approval.status() !== 302)
    throw new Error(
      `Consent failed: ${approval.status()} ${(await approval.json()).error}`,
    );
  await page.waitForURL(`${callbackRoot}/callback**`, { timeout: 3000 });
  const callback = new URL((await approvalResponse).headers().location);
  expect(callback.searchParams.get("state")).toBe("test-state");
  const code = callback.searchParams.get("code");
  await page.goto(`${root}/auth`);
  const exchange = (params) =>
    fetch(`${root}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: client.client_id, ...params }),
    });
  const grantParams = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: client.redirect_uris[0],
    resource: `${root}/mcp`,
  };
  expect(
    (
      await exchange({
        ...grantParams,
        code_verifier: "wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456789",
      })
    ).status,
  ).toBe(400);
  expect(
    (await exchange({ ...grantParams, resource: `${root}/jmap` })).status,
  ).toBe(400);
  const issued = await exchange(grantParams);
  expect(issued.status).toBe(200);
  const tokens = await issued.json();
  expect(tokens.expires_in).toBe(900);
  expect(tokens.refresh_token).toBeTruthy();
  const mcp = (token) =>
    fetch(`${root}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const tools = await mcp(tokens.access_token);
  expect(tools.status).toBe(200);
  const text = await tools.text();
  expect(text).toContain("mail_read");
  expect(text).not.toContain('"name":"mail_send"');
  expect(
    (
      await fetch(`${root}/.well-known/jmap`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).status,
  ).toBe(401);
  const refreshed = await exchange({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  expect(refreshed.status).toBe(200);
  const second = await refreshed.json();
  expect(second.refresh_token).not.toBe(tokens.refresh_token);
  const third = await exchange({
    grant_type: "refresh_token",
    refresh_token: second.refresh_token,
  });
  expect(third.status).toBe(200);
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      })
    ).status,
  ).toBe(400);
  const grants = (await session()).grants;
  expect(grants).toHaveLength(1);
  expect(
    (await protectedPost("/auth/grants/revoke", { id: grants[0].id })).status,
  ).toBe(200);
  expect((await mcp(second.access_token)).status).toBe(401);
  expect(
    (
      await exchange({
        grant_type: "refresh_token",
        refresh_token: (await third.json()).refresh_token,
      })
    ).status,
  ).toBe(400);
  expect((await exchange(grantParams)).status).toBe(400);
}, 20000);

test("JMAP OAuth omits refresh tokens without offline permission and serializes concurrent code exchange", async () => {
  await createRegisteredOwner(harness);
  const client = await (
    await fetch(`${root}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "JMAP client",
        redirect_uris: [`${callbackRoot}/callback`],
        token_endpoint_auth_method: "none",
      }),
    })
  ).json();
  const verifier = "v".repeat(43);
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const getCode = async () => {
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${root}/jmap`,
      scope: "read",
    });
    await page.goto(`${root}/authorize?${params}`);
    await page.locator('input[value="offline_access"]').uncheck();
    const approved = page.waitForResponse(
      (r) => r.url() === `${root}/authorize` && r.request().method() === "POST",
    );
    await page
      .locator('#consent button[value="approve"]')
      .click({ noWaitAfter: true });
    const response = await approved;
    expect(response.status()).toBe(302);
    await page.waitForURL(`${callbackRoot}/callback**`);
    const code = new URL(response.headers().location).searchParams.get("code");
    await page.goto(`${root}/auth`);
    return code;
  };
  const exchange = (code) =>
    fetch(`${root}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code,
        code_verifier: verifier,
        resource: `${root}/jmap`,
      }),
    });
  const issued = await exchange(await getCode());
  expect(issued.status).toBe(200);
  const token = await issued.json();
  expect(token.refresh_token).toBeUndefined();
  expect(
    (
      await fetch(`${root}/jmap/session`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${root}/mcp`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    ).status,
  ).toBe(401);
  const code = await getCode();
  const raced = await Promise.all([exchange(code), exchange(code)]);
  expect(raced.map((r) => r.status).sort()).toEqual([200, 400]);
  const payload = { name: "Expired proof", scopes: ["read"] };
  const expiredProof = await proof("/auth/apps/new", payload);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "postlet-auth-test",
    "AuthState",
    { name: "owner" },
  );
  await storage.exec(
    "UPDATE auth_values SET expires=1 WHERE name=?",
    `auth:proof:${await sha256(expiredProof)}`,
  );
  expect(
    (await post("/auth/apps/new", payload, { proof: expiredProof })).status,
  ).toBe(403);
});

test("recovery codes are single-use and cannot access data or authorize clients until a new Passkey login", async () => {
  const recoveryCodes = await createRegisteredOwner(harness);
  await page.goto(`${root}/auth`);
  await post("/auth/logout", {});
  expect((await post("/auth/recover", { code: recoveryCodes[0] })).status).toBe(
    200,
  );
  expect((await post("/auth/recover", { code: recoveryCodes[0] })).status).toBe(
    401,
  );
  expect(
    (await post("/auth/apps/new", { name: "forbidden", scopes: ["read"] }))
      .status,
  ).toBe(401);
  await page.reload();
  await page.waitForFunction(
    () => !document.getElementById("registration").hidden,
  );
  // A new authenticator models replacing a lost device.
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  expect((await register()).requiresLogin).toBe(true);
  expect((await session()).session).toBeNull();
  await login();
  expect((await session()).keys).toHaveLength(2);
  const replacement = await protectedPost("/auth/recovery/new", {});
  expect(replacement.data.codes).toHaveLength(8);
  await post("/auth/logout", {});
  expect((await post("/auth/recover", { code: recoveryCodes[1] })).status).toBe(
    401,
  );
});

test("expiry is enforced for app passwords, recovery codes, Passkeys and their browser sessions", async () => {
  await createRegisteredOwner(harness);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "postlet-auth-test",
    "AuthState",
    { name: "owner" },
  );
  const application = await protectedPost("/auth/apps/new", {
    name: "Expires",
    scopes: ["read"],
  });
  expect(application.status).toBe(200);
  await storage.exec(
    "UPDATE auth_values SET value=json_set(value,'$.expiresAt',?) WHERE name=?",
    "2000-01-01T00:00:00.000Z",
    `auth:app:${await sha256(application.data.token)}`,
  );
  expect(
    (
      await fetch(`${root}/jmap/session`, {
        headers: { Authorization: `Bearer ${application.data.token}` },
      })
    ).status,
  ).toBe(401);
  const codes = (await protectedPost("/auth/recovery/new", {})).data.codes;
  await storage.exec(
    "UPDATE auth_values SET value=json_set(value,'$.expiresAt',?) WHERE name=?",
    "2000-01-01T00:00:00.000Z",
    `auth:recovery:${await sha256(codes[0])}`,
  );
  expect((await post("/auth/recover", { code: codes[0] })).status).toBe(401);
  const keys = (await session()).keys;
  for (const key of keys)
    await storage.exec(
      "UPDATE auth_values SET value=json_set(value,'$.expiresAt',?) WHERE name=?",
      "2000-01-01T00:00:00.000Z",
      `auth:key:${key.id}`,
    );
  expect((await session()).session).toBeNull();
  const start = await post("/auth/login/options", {});
  const assertion = await page.evaluate(
    (optionsJSON) =>
      window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON }),
    start.data.options,
  );
  expect(
    (
      await post("/auth/login/verify", {
        id: start.data.id,
        response: assertion,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${root}/jmap/session`, {
        headers: { Authorization: `Bearer ${owner}` },
      })
    ).status,
  ).toBe(401);
});

test("Cloudflare administrative recovery is single-use and only permits replacement-key enrollment", async () => {
  const codes = await createRegisteredOwner(harness);
  await protectedPost("/auth/apps/new", {
    name: "Original key's app",
    scopes: ["read"],
  });
  await post("/auth/logout", {});
  expect((await post("/auth/recover", { code: codes[0] })).status).toBe(200);
  await page.reload();
  await page.waitForFunction(
    () => !document.getElementById("registration").hidden,
  );
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  expect((await register()).requiresLogin).toBe(true);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "postlet-auth-test",
    "AuthState",
    { name: "owner" },
  );
  await storage.exec(
    "UPDATE auth_values SET value=json_set(value,'$.expiresAt',?) WHERE name LIKE 'auth:key:%'",
    "2000-01-01T00:00:00.000Z",
  );
  expect(
    (
      await fetch(`${root}/auth/admin-recovery`, {
        method: "POST",
        headers: { Authorization: `Bearer ${owner}` },
      })
    ).status,
  ).toBe(401);
  const response = await fetch(`${root}/auth/admin-recovery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminRecovery}` },
  });
  expect(response.status).toBe(200);
  await page.goto((await response.json()).url);
  await page.waitForFunction(
    () => !document.getElementById("registration").hidden,
  );
  expect(
    (
      await fetch(`${root}/auth/admin-recovery`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminRecovery}` },
      })
    ).status,
  ).toBe(409);
  expect(
    (await post("/auth/apps/new", { name: "forbidden", scopes: ["read"] }))
      .status,
  ).toBe(401);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  expect((await register()).requiresLogin).toBe(true);
  await login();
  // The first key issued the now-consumed recovery code which issued key 2.
  // Cascading must follow that used code's ancestry; the independent admin key survives.
  const keys = (await session()).keys.sort((a, b) => a.createdAt - b.createdAt);
  expect(
    (
      await protectedPost("/auth/keys/delete", {
        id: keys[0].id,
        cascade: true,
      })
    ).status,
  ).toBe(200);
  expect((await session()).keys).toHaveLength(1);
  expect((await session()).apps).toHaveLength(0);
});

test("authentication failures return localized messages rather than internal error identifiers", async () => {
  for (const [locale, expected] of [
    ["en", "Requests from other websites are not allowed."],
    ["zh-Hans", "不允许来自其他网站的请求。"],
    ["zh-Hant", "不允許來自其他網站的請求。"],
  ]) {
    const response = await fetch(`${root}/auth/login/options?lang=${locale}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://other.example",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expected });
  }
});

test("native UI supports three languages, narrow screens, keyboard navigation and accessible contrast", async () => {
  await createRegisteredOwner(harness);
  for (const [locale, title] of [
    ["en", "Account access"],
    ["zh-Hans", "账户访问"],
    ["zh-Hant", "帳戶存取"],
  ]) {
    await page.setViewportSize({ width: 320, height: 812 });
    await page.goto(`${root}/auth?lang=${locale}`);
    expect(await page.locator("html").getAttribute("lang")).toBe(locale);
    expect(await page.locator("h1").textContent()).toBe(title);
    await page.waitForFunction(
      () => !document.getElementById("management").hidden,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.screenshot({
    path: "/tmp/postlet-passkey-mobile-dark.png",
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.emulateMedia({ forcedColors: "active" });
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement !== document.body),
  ).toBe(true);
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${root}/auth?lang=en`);
  await page.screenshot({
    path: "/tmp/postlet-passkey-desktop.png",
    fullPage: true,
  });
}, 30000);

test("administrative recovery after authentication storage loss does not silently issue undisclosed recovery codes", async () => {
  await createRegisteredOwner(harness);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "postlet-auth-test",
    "AuthState",
    { name: "owner" },
  );
  await storage.exec("DELETE FROM auth_values");
  const response = await fetch(`${root}/auth/admin-recovery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminRecovery}` },
  });
  expect(response.status).toBe(200);
  await page.goto((await response.json()).url);
  await page.waitForFunction(
    () => !document.getElementById("registration").hidden,
  );
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  expect((await register()).requiresLogin).toBe(true);
  await login();
  expect((await session()).recovery).toEqual([]);
  expect(
    (await protectedPost("/auth/recovery/new", {})).data.codes,
  ).toHaveLength(8);
});
