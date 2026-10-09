import assert from "node:assert/strict";
import { serviceUrl } from "./settings.js";

const root = serviceUrl();
const authorization = await (
  await fetch(`${root}/.well-known/oauth-authorization-server`)
).json();
assert.equal(authorization.issuer, root);
assert.equal(authorization.authorization_endpoint, `${root}/authorize`);
assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
for (const resource of ["mcp", "jmap"]) {
  const metadata = await (
    await fetch(`${root}/.well-known/oauth-protected-resource/${resource}`)
  ).json();
  assert.equal(metadata.resource, `${root}/${resource}`);
  assert.deepEqual(metadata.authorization_servers, [root]);
  assert.equal((await fetch(`${root}/${resource}`)).status, 401);
}
for (const lang of ["en", "zh-Hans", "zh-Hant"]) {
  const response = await fetch(`${root}/auth?lang=${lang}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Language"), lang);
  assert.equal(response.headers.get("Referrer-Policy"), "same-origin");
  assert(
    response.headers
      .get("Content-Security-Policy")
      .includes("frame-ancestors 'none'"),
  );
  assert((await response.text()).includes(`<html lang="${lang}">`));
}
assert.deepEqual(
  (await (await fetch(`${root}/auth/session`)).json()).session,
  null,
);
assert.equal(
  (
    await fetch(`${root}/auth/login/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).status,
  403,
);
const optionsResponse = await fetch(`${root}/auth/login/options`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: root },
  body: "{}",
});
assert.equal(optionsResponse.status, 200);
const { options } = await optionsResponse.json();
assert.equal(options.rpId, new URL(root).hostname);
assert.equal(options.userVerification, "required");
for (const script of ["client.js", "webauthn.js", "consent.js"]) {
  const response = await fetch(`${root}/auth/${script}`);
  assert.equal(response.status, 200);
  assert(response.headers.get("Content-Type").startsWith("text/javascript"));
}
console.log(
  "OAuth discovery, protected resources, three UI languages, CSRF, WebAuthn options and browser assets: passed.",
);
