/* global SimpleWebAuthnBrowser */
let csrf;
let sessionKind;
const $ = (id) => document.getElementById(id);
const t = JSON.parse($("copy").textContent);
const date = (value) =>
  new Date(value).toLocaleDateString(document.documentElement.lang);
const message = (text) => {
  $("message").textContent = text;
};
async function api(path, body, proof) {
  const response = await fetch(`/auth/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-Postlet-CSRF": csrf } : {}),
      ...(proof ? { "X-Postlet-Proof": proof } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (data.csrf) csrf = data.csrf;
  return data;
}
async function authorized(path, body) {
  if (sessionKind !== "user") return api(path, body);
  const start = await api("reauth/options", {
    action: `/auth/${path}`,
    payload: body,
  });
  const response = await SimpleWebAuthnBrowser.startAuthentication({
    optionsJSON: start.options,
  });
  const { proof } = await api("reauth/verify", { id: start.id, response });
  return api(path, body, proof);
}
function reveal(value) {
  $("secret-value").textContent = value;
  $("secret").hidden = false;
  $("secret-title").focus();
}
function list(id, items, describe, remove, renew) {
  $(id).replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = describe(item);
    li.append(text);
    const button = document.createElement("button");
    button.textContent = t.revoke;
    button.setAttribute("aria-label", `${t.revoke}: ${describe(item)}`);
    button.addEventListener("click", () =>
      action(async () => {
        await remove(item);
        await refresh();
      }),
    );
    li.append(button);
    if (renew) {
      const button = document.createElement("button");
      button.textContent = t.renew;
      button.setAttribute("aria-label", `${t.renew}: ${describe(item)}`);
      button.addEventListener("click", () =>
        action(async () => {
          await renew(item);
          await refresh();
        }),
      );
      li.append(button);
    }
    $(id).append(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = t.empty;
    $(id).append(li);
  }
}
async function refresh() {
  const data = await api("session");
  sessionKind = data.session?.kind;
  $("signed-out").hidden = !!data.session;
  $("registration").hidden = !data.session;
  $("management").hidden = data.session?.kind !== "user";
  if (data.session?.kind === "user") {
    list(
      "keys",
      data.keys,
      (k) => `${k.name} · ${t.expires}: ${date(k.expiresAt)}`,
      (k) =>
        authorized("keys/delete", { id: k.id, cascade: $("cascade").checked }),
      (k) => authorized("keys/renew", { id: k.id }),
    );
    list(
      "grants",
      data.grants,
      (g) => `${g.metadata?.clientName || g.clientId} · ${g.scope.join(", ")}`,
      (g) => authorized("grants/revoke", { id: g.id }),
    );
    list(
      "apps",
      data.apps,
      (a) =>
        `${a.name} · ${a.scopes.map((s) => t[s]).join(", ")} · ${t.expires}: ${date(a.expiresAt)}`,
      (a) => authorized("apps/revoke", { id: a.id }),
      async (a) => {
        const result = await authorized("apps/renew", { id: a.id });
        reveal(result.token);
        message(t.rotated);
      },
    );
    $("recovery-status").textContent = data.recovery.length
      ? `${t.activeCodes}: ${data.recovery.length} · ${t.expires}: ${date(data.recovery[0].expiresAt)}`
      : t.noCodes;
    const next = new URLSearchParams(location.search).get("next");
    if (
      $("secret").hidden &&
      next?.startsWith("/authorize?") &&
      !next.includes("\\")
    )
      location.assign(next);
  }
}
async function action(fn) {
  try {
    message("");
    await fn();
  } catch (error) {
    message(
      error.name === "NotAllowedError" || error.code
        ? t.canceled
        : error.message || t.failed,
    );
    $("message").focus();
  }
}
$("login").addEventListener("click", () =>
  action(async () => {
    const start = await api("login/options", {});
    const response = await SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: start.options,
    });
    await api("login/verify", { id: start.id, response });
    await refresh();
  }),
);
$("register").addEventListener("click", () =>
  action(async () => {
    const start = await authorized("register/options", {
      name: $("key-name").value,
    });
    const response = await SimpleWebAuthnBrowser.startRegistration({
      optionsJSON: start.options,
    });
    const result = await api("register/verify", { id: start.id, response });
    if (result.recoveryCodes) reveal(result.recoveryCodes.join("\n"));
    if (result.requiresLogin) {
      message(t.loginNew);
    } else message(t.keyAdded);
    await refresh();
  }),
);
$("recover").addEventListener("click", () =>
  action(async () => {
    await api("recover", { code: $("recovery").value.trim() });
    $("recovery").value = "";
    await refresh();
  }),
);
$("new-recovery").addEventListener("click", () =>
  action(async () => {
    if (!confirm(t.confirmRecovery)) return;
    const result = await authorized("recovery/new", {});
    reveal(result.codes.join("\n"));
    await refresh();
  }),
);
$("new-app").addEventListener("click", () =>
  action(async () => {
    const scopes = ["read"];
    if ($("app-write").checked || $("app-send").checked) scopes.push("write");
    if ($("app-send").checked) scopes.push("send");
    const result = await authorized("apps/new", {
      name: $("app-name").value,
      scopes,
    });
    reveal(result.token);
    await refresh();
  }),
);
$("revoke-all").addEventListener("click", () =>
  action(async () => {
    if (confirm(t.confirmAll)) {
      await authorized("grants/revoke", { all: true });
      await refresh();
    }
  }),
);
$("logout").addEventListener("click", () =>
  action(async () => {
    await api("logout", {});
    location.assign("/auth");
  }),
);
$("saved").addEventListener("click", () => {
  $("secret-value").textContent = "";
  $("secret").hidden = true;
  action(refresh);
});
async function initialize() {
  const setup = new URLSearchParams(location.hash.slice(1)).get("setup");
  if (setup) {
    history.replaceState(null, "", location.pathname);
    await api("bootstrap/claim", { token: setup });
  }
  await refresh();
  if (!window.PublicKeyCredential || !window.isSecureContext) {
    message(t.unsupported);
    $("login").disabled = true;
    $("register").disabled = true;
  }
}
window.addEventListener("hashchange", () => action(initialize));
action(initialize);
