import { readToken, serviceUrl } from "./settings.js";

const [command = "status", ...args] = process.argv.slice(2);
if (
  !["status", "retry-inbound", "storage"].includes(command) ||
  (command === "status" && args.length) ||
  (command === "storage" && args.some((arg) => arg !== "--apply")) ||
  (command === "retry-inbound" &&
    (!args.length || args.some((id) => !/^[A-Za-z0-9_-]{1,255}$/.test(id))))
)
  throw new Error(
    "Usage: bun scripts/maintenance.js status | retry-inbound <receipt-id>... | storage [--apply]",
  );
const url = serviceUrl();
const token = await readToken();
const path =
  command === "status"
    ? "/admin/status"
    : command === "storage"
      ? "/admin/storage"
      : "/admin/inbound/retry";
const response = await fetch(`${url}${path}`, {
  method: command === "status" ? "GET" : "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  ...(command === "status"
    ? {}
    : {
        body: JSON.stringify(
          command === "storage"
            ? { apply: args.includes("--apply") }
            : { ids: args },
        ),
      }),
});
if (!response.ok)
  throw new Error(
    `Maintenance failed: HTTP ${response.status}; request ${response.headers.get("X-Request-ID") || "unknown"}`,
  );
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (result.deferred) process.exitCode = 2;
