import assert from "node:assert/strict";
import { connect } from "./client.js";
import { serviceUrl } from "./settings.js";

const origin = serviceUrl();
const domain = process.env.POSTLET_MAIL_DOMAIN;
const expected = process.env.POSTLET_SRV_TARGET;
assert(
  domain && expected,
  "Set POSTLET_MAIL_DOMAIN and POSTLET_SRV_TARGET explicitly.",
);
assert(
  /^[a-z0-9.-]+$/i.test(domain) && /^[a-z0-9.-]+$/i.test(expected),
  "Domain and SRV target must be DNS hostnames.",
);
const response = await fetch(
  `https://cloudflare-dns.com/dns-query?name=_jmap._tcp.${domain}&type=SRV`,
  { headers: { Accept: "application/dns-json" } },
);
assert(response.ok, `DNS lookup failed: HTTP ${response.status}`);
const dns = await response.json();
const srv = (dns.Answer || [])
  .filter((record) => record.type === 33)
  .map((record) => {
    const [priority, weight, port, hostname] = record.data.trim().split(/\s+/);
    return {
      priority: Number(priority),
      weight: Number(weight),
      port: Number(port),
      hostname: hostname.replace(/\.$/, ""),
    };
  });
assert(
  srv.some((record) => record.port === 443 && record.hostname === expected),
  `Expected SRV target ${expected}:443; received ${JSON.stringify(srv)}`,
);
// Only send the mailbox credential to the exact operator-configured endpoint,
// never to an arbitrary hostname returned by DNS.
const client = await connect(`https://${expected}`);
assert.equal(client.session.apiUrl, `${origin}/jmap`);
const [mailboxes] = await client.jmap([["Mailbox/get", { ids: ["m_inbox"] }]]);
assert.equal(mailboxes.list[0].role, "inbox");
console.log(
  JSON.stringify(
    {
      srv,
      session: "passed",
      apiUrl: client.session.apiUrl,
      authenticatedJmap: "passed",
    },
    null,
    2,
  ),
);
