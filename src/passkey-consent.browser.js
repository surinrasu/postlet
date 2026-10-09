/* global SimpleWebAuthnBrowser */
const form = document.getElementById("consent");
const t = JSON.parse(document.getElementById("copy").textContent);
form.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "approve") return;
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const session = await (await fetch("/auth/session")).json();
    const call = async (path, body) => {
      const response = await fetch(`/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Postlet-CSRF": session.csrf,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    };
    const fields = new FormData(form);
    const payload = {
      handle: fields.get("handle"),
      decision: "approve",
      scope: fields.getAll("scope"),
    };
    const start = await call("reauth/options", {
      action: "/authorize",
      payload,
    });
    const response = await SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: start.options,
    });
    const { proof } = await call("reauth/verify", { id: start.id, response });
    for (const [name, value] of Object.entries({
      proof,
      decision: "approve",
    })) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    form.submit();
  } catch (error) {
    document.getElementById("message").textContent =
      error.name === "NotAllowedError" || error.code
        ? t.canceled
        : error.message || t.failed;
    document.getElementById("message").focus();
    button.disabled = false;
  }
});
