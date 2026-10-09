import { AsyncLocalStorage } from "node:async_hooks";

/** @type {!AsyncLocalStorage<{requestId: string}>} */
const context = new AsyncLocalStorage();
/** @template T @param {string} requestId @param {function(): T} callback @returns {T} */
export function withRequestId(requestId, callback) {
  return context.run({ requestId }, callback);
}

// Only explicitly selected fields reach logs; exception messages and arbitrary
// provider payloads can contain message bodies, addresses, or credentials.
const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "JmapError",
  "AuthError",
]);
const ERROR_CODES = new Set([
  "invalidEmail",
  "tooLarge",
  "serverFail",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_SENDER_NOT_VERIFIED",
  "E_CONTENT_TOO_LARGE",
  "E_INVALID_EMAIL",
  "E_RECIPIENT_SUPPRESSED",
  "E_INVALID_SENDER",
  "E_INVALID_RECIPIENT",
]);

/** @param {*} error */
export function errorFields(error) {
  const name = error instanceof Error ? error.name : "Error";
  const code =
    error && typeof error === "object"
      ? "type" in error
        ? error.type
        : "code" in error
          ? error.code
          : undefined
      : undefined;
  return {
    errorName: ERROR_NAMES.has(name) ? name : "Error",
    errorCode:
      typeof code === "string" && ERROR_CODES.has(code) ? code : "unexpected",
  };
}

/** @param {string} event @param {Object<string, (string|number|boolean|null)>=} fields @param {*=} error */
export function logEvent(event, fields = {}, error) {
  const record = JSON.stringify({
    event,
    ...context.getStore(),
    ...fields,
    ...(error === undefined ? {} : errorFields(error)),
  });
  if (error === undefined) console.log(record);
  else console.error(record);
}
