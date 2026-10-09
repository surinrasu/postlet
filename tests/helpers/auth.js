import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect } from "vitest";
import { sha256 } from "../../src/util.js";
import { workerModules } from "../integration/modules.js";

export const adminRecovery = "r".repeat(43);
export const owner = "local-auth-owner-not-a-production-secret";
export const reader = "local-auth-reader-not-a-production-secret";

export async function createAuthHarness(browser) {
  let mf, page, context, cdp, authenticatorId, directory, root;
  let callbackServer, callbackRoot;
  const fetch = (...args) => mf.dispatchFetch(...args);
  async function post(path, body, options = {}) {
    return page.evaluate(
      async ({ path, body, options }) => {
        const session = await (await fetch("/auth/session")).json();
        const response = await fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(!options.noCSRF ? { "X-Postlet-CSRF": session.csrf } : {}),
            ...(options.proof ? { "X-Postlet-Proof": options.proof } : {}),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      },
      { path, body, options },
    );
  }
  async function session() {
    return page.evaluate(async () => (await fetch("/auth/session")).json());
  }
  async function proof(path, payload) {
    const start = await post("/auth/reauth/options", { action: path, payload });
    expect(start.status).toBe(200);
    const response = await page.evaluate(
      (optionsJSON) =>
        window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON }),
      start.data.options,
    );
    const verified = await post("/auth/reauth/verify", {
      id: start.data.id,
      response,
    });
    expect(verified.status).toBe(200);
    return verified.data.proof;
  }
  async function protectedPost(path, payload) {
    return post(path, payload, { proof: await proof(path, payload) });
  }
  async function login() {
    await page.goto(`${root}/auth`);
    const verified = page.waitForResponse((r) =>
      r.url().endsWith("/auth/login/verify"),
    );
    await page.click("#login");
    expect((await verified).status()).toBe(200);
    await page.waitForFunction(
      () => !document.getElementById("management").hidden,
    );
  }
  async function register() {
    const verified = page.waitForResponse((r) =>
      r.url().endsWith("/auth/register/verify"),
    );
    await page.click("#register");
    const response = await verified;
    expect(await response.json()).not.toHaveProperty("error");
    expect(response.status()).toBe(200);
    return response.json();
  }

  async function close() {
    try {
      await context?.close();
    } finally {
      try {
        await mf?.dispose();
      } finally {
        if (callbackServer?.listening)
          await new Promise((resolve) => callbackServer.close(resolve));
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  }

  try {
    callbackServer = createHttpServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("Authorized");
    });
    await new Promise((resolve) =>
      callbackServer.listen(0, "127.0.0.1", resolve),
    );
    callbackRoot = `http://127.0.0.1:${callbackServer.address().port}`;
    const port = await new Promise((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    root = `https://localhost:${port}`;
    directory = await mkdtemp(join(tmpdir(), "postlet-auth-test-"));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "postlet-auth-test",
        host: "127.0.0.1",
        https: true,
        port,
        modules: workerModules(),
        compatibilityDate: "2026-10-09",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        cf: false,
        unsafeInspectDurableObjects: true,
        resourcePersistencePath: directory,
        durableObjects: {
          ACCOUNT: { className: "MailAccount", useSQLite: true },
          AUTH: { className: "AuthState", useSQLite: true },
        },
        r2Buckets: ["MAIL"],
        bindings: {
          PUBLIC_URL: root,
          ACCOUNT_ID: "personal",
          MAIL_DOMAIN: "example.test",
          MAIL_ADDRESS: "root@example.test",
          MAIL_NAME: "Test",
          SEND_ENABLED: "false",
          PASSKEY_RECOVERY_SHA256: await sha256(adminRecovery),
          AUTH_TOKENS: JSON.stringify([
            {
              id: "owner",
              sha256: await sha256(owner),
              scopes: ["read", "write", "send"],
            },
            { id: "reader", sha256: await sha256(reader), scopes: ["read"] },
          ]),
        },
      }),
    );
    await mf.ready;
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.on("pageerror", (error) =>
      console.error("Browser error:", error.message),
    );
    cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
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
  } catch (error) {
    await close();
    throw error;
  }
  return {
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
    close,
  };
}

export async function createRegisteredOwner(harness) {
  const response = await harness.fetch(`${harness.root}/auth/bootstrap`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner}` },
  });
  expect(response.status).toBe(200);
  await harness.page.goto((await response.json()).url);
  await harness.page.waitForFunction(
    () => !document.getElementById("registration").hidden,
  );
  const result = await harness.register();
  expect(result.recoveryCodes).toHaveLength(8);
  await harness.page.waitForFunction(
    () => !document.getElementById("management").hidden,
  );
  return result.recoveryCodes;
}
