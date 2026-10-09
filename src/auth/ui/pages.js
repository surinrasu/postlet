import { language, messages } from "../../auth-i18n.js";
import { escapeHTML, html } from "./layout.js";

const statusMessage = `<p id="message" role="status" aria-live="polite" tabindex="-1"></p>`;
const script = (name) => `<script src="/auth/${name}.js" defer></script>`;

function signedOutSection(t) {
  return `
    <section id="signed-out">
      <button id="login">${t.login}</button>
      <details>
        <summary>${t.recovery}</summary>
        <p>${t.recoveryHelp}</p>
        <label for="recovery">${t.recoveryCode}</label>
        <input id="recovery" type="password" autocomplete="off" spellcheck="false" autocapitalize="none">
        <button id="recover">${t.recover}</button>
      </details>
      <p>${t.setup} <code>bun scripts/passkey-setup.js</code></p>
    </section>`;
}

function registrationSection(t) {
  return `
    <section id="registration" hidden>
      <h2>${t.addKey}</h2>
      <label for="key-name">${t.keyName}</label>
      <input id="key-name" type="text" maxlength="80" value="${escapeHTML(t.defaultKey)}" autocomplete="off">
      <button id="register">${t.createKey}</button>
    </section>`;
}

function managementSection(t) {
  return `
    <section id="management" hidden>
      <h2>${t.keys}</h2>
      <label><input id="cascade" type="checkbox">${t.cascade}</label>
      <ul id="keys"></ul>
      <h2>${t.clients}</h2>
      <ul id="grants"></ul>
      <button id="revoke-all">${t.revokeAll}</button>
      <h2>${t.recoveryTitle}</h2>
      <p id="recovery-status"></p>
      <p>${t.recoveryInfo}</p>
      <button id="new-recovery">${t.newRecovery}</button>
      <h2>${t.apps}</h2>
      <p>${t.appHelp}</p>
      <label for="app-name">${t.appName}</label>
      <input id="app-name" type="text" maxlength="80" autocomplete="off">
      <label><input id="app-write" type="checkbox">${t.write}</label>
      <label><input id="app-send" type="checkbox">${t.send}</label>
      <button id="new-app">${t.createApp}</button>
      <ul id="apps"></ul>
      <button id="logout">${t.logout}</button>
    </section>`;
}

function secretSection(t) {
  return `
    <section id="secret" hidden aria-labelledby="secret-title">
      <h2 id="secret-title" tabindex="-1">${t.save}</h2>
      <p>${t.saveHelp}</p>
      <pre id="secret-value" tabindex="0"></pre>
      <button id="saved">${t.saved}</button>
    </section>`;
}

export function loginPage(request) {
  const t = messages(language(request));
  return html(
    request,
    `
    <h1>${t.title}</h1>
    <p>${t.intro}</p>
    ${statusMessage}
    ${signedOutSection(t)}
    ${registrationSection(t)}
    ${managementSection(t)}
    ${secretSection(t)}
    ${script("webauthn")}
    ${script("client")}
  `,
  );
}

function permissions(t, requested) {
  return ["read", "write", "send", "offline_access"]
    .map((scope) => {
      const checked =
        scope === "read" ||
        scope === "offline_access" ||
        requested.includes(scope);
      return `<label><input type="checkbox" name="scope" value="${scope}"${checked ? " checked" : ""}>${t[scope]}</label>`;
    })
    .join("\n");
}

export function consentPage(request, details, handle, headers) {
  const t = messages(language(request));
  const domain = details.clientDomain
    ? `${t.domain}: <strong>${escapeHTML(details.clientDomain)}</strong>`
    : t.unverified;
  return html(
    request,
    `
    <h1>${t.authorize}</h1>
    ${statusMessage}
    <p><strong>${escapeHTML(details.clientName)}</strong> ${t.request}</p>
    <p>${domain}</p>
    <p>${t.returnTo}: <strong>${escapeHTML(details.redirectHost)}</strong></p>
    ${details.redirectIsLoopback ? `<p>${t.localClient}</p>` : ""}
    <form id="consent" method="post" action="/authorize">
      <input type="hidden" name="handle" value="${escapeHTML(handle)}">
      <fieldset>
        <legend>${t.permissions}</legend>
        ${permissions(t, details.scope)}
      </fieldset>
      <p>${t.scopeHelp}</p>
      <button name="decision" value="approve">${t.allow}</button>
      <button name="decision" value="deny">${t.deny}</button>
    </form>
    <p>${t.consentHelp}</p>
    ${script("webauthn")}
    ${script("consent")}
  `,
    headers,
    new URL(details.redirectUri).origin,
  );
}
