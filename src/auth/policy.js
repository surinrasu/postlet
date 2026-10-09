export const COOKIE = "__Host-postlet-session";
export const CEREMONY = "__Host-postlet-ceremony";
export const SCOPES = ["read", "write", "send", "offline_access"];
export const CREDENTIAL_TTL = 90 * 86400;
export const MUTATIONS = [
  "/auth/register/options",
  "/auth/keys/renew",
  "/auth/keys/delete",
  "/auth/recovery/new",
  "/auth/apps/new",
  "/auth/apps/renew",
  "/auth/apps/revoke",
  "/auth/grants/revoke",
  "/authorize",
];
export const active = (credential) =>
  credential && Date.parse(credential.expiresAt) > Date.now();
export const lifetime = (parentId) => ({
  parentId,
  createdAt: Date.now(),
  expiresAt: new Date(Date.now() + CREDENTIAL_TTL * 1000).toISOString(),
});
export const random = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const now = () => Date.now();
export class AuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}
export function check(condition, code, status) {
  if (!condition) throw new AuthError(code, status);
}
export function cookie(request, name) {
  return (request.headers.get("Cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function label(value) {
  check(
    typeof value === "string" && value.trim().length > 0 && value.length <= 80,
    "invalidLabel",
  );
  return value.trim();
}
export function scopes(value, offline = false) {
  check(
    Array.isArray(value) &&
      value.every((s) => (offline ? SCOPES : SCOPES.slice(0, 3)).includes(s)),
    "invalidPermissions",
  );
  check(
    value.includes("read") &&
      (!value.includes("send") || value.includes("write")),
    "missingPermissions",
  );
  return [...new Set(value)];
}
