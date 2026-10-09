import { readToken, serviceUrl } from "./settings.js";

export async function connect(baseUrl) {
  const url = serviceUrl(baseUrl);
  const token = await readToken();
  const headers = { Authorization: `Bearer ${token}` };
  const sessionResponse = await fetch(`${url}/.well-known/jmap`, { headers });
  if (!sessionResponse.ok)
    throw new Error(`Session request failed: HTTP ${sessionResponse.status}`);
  const session = await sessionResponse.json();
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  async function jmap(calls) {
    const result = await fetch(session.apiUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        using: Object.keys(session.capabilities),
        methodCalls: calls.map(([name, args], i) => [
          name,
          { accountId, ...args },
          String(i),
        ]),
      }),
    });
    if (!result.ok)
      throw new Error(`JMAP request failed: HTTP ${result.status}`);
    const body = await result.json();
    for (const [name, args] of body.methodResponses) {
      if (name === "error") throw new Error(`JMAP error: ${args.type}`);
      if (args.notCreated || args.notUpdated || args.notDestroyed)
        throw new Error(
          `JMAP set failed: ${JSON.stringify({ notCreated: args.notCreated, notUpdated: args.notUpdated, notDestroyed: args.notDestroyed })}`,
        );
    }
    return body.methodResponses.map(([, args]) => args);
  }
  const downloadUrl = (blobId) =>
    session.downloadUrl
      .replace("{accountId}", encodeURIComponent(accountId))
      .replace("{blobId}", encodeURIComponent(blobId))
      .replace("{name}", "message.eml")
      .replace("{type}", "message%2Frfc822");
  return { url, headers, session, accountId, jmap, downloadUrl };
}
