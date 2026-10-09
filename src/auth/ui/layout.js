import { language, messages } from "../../auth-i18n.js";
import styles from "./auth.css";

export const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function html(request, body, headers = new Headers(), formTarget = "") {
  const locale = language(request),
    t = messages(locale),
    url = new URL(request.url);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Language", locale);
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self' ${formTarget}; frame-ancestors 'none'`,
  );
  // Native form POSTs need their same-origin Origin header. no-referrer can
  // serialize it as null; same-origin still withholds referrers from clients.
  headers.set("Referrer-Policy", "same-origin");
  if (url.searchParams.has("lang"))
    headers.append(
      "Set-Cookie",
      `postlet-language=${locale}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    );
  const preserved = [...url.searchParams]
    .filter(([key]) => key !== "lang")
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHTML(key)}" value="${escapeHTML(value)}">`,
    )
    .join("");
  const options = [
    ["en", "English"],
    ["zh-Hans", "简体中文"],
    ["zh-Hant", "繁體中文"],
  ]
    .map(
      ([value, text]) =>
        `<option value="${value}"${value === locale ? " selected" : ""}>${text}</option>`,
    )
    .join("\n");
  const languageForm = `
    <form class="language" method="get" action="${escapeHTML(url.pathname)}">
      ${preserved}
      <label for="language">${t.language}</label>
      <select id="language" name="lang">${options}</select>
      <button>${t.applyLanguage}</button>
    </form>`;
  return new Response(
    `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Postlet · ${t.title}</title>
    <style>${styles}</style>
  </head>
  <body>
    <header><a href="/auth">Postlet</a>${languageForm}</header>
    <main>${body}</main>
    <script type="application/json" id="copy">${JSON.stringify(t).replaceAll("<", "\\u003c")}</script>
  </body>
</html>`,
    { headers },
  );
}
