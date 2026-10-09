import browserLibrary from "../../../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js";
import clientScript from "../../passkey-client.browser.js";
import consentScript from "../../passkey-consent.browser.js";

export function authAsset(path) {
  const script =
    path === "/auth/webauthn.js"
      ? browserLibrary
      : path === "/auth/client.js"
        ? clientScript
        : path === "/auth/consent.js"
          ? consentScript
          : null;
  return script === null
    ? null
    : new Response(script, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
}
