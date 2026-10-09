import { logEvent } from "./observability.js";

export class JmapError extends Error {
  constructor(type, description = type, details = {}) {
    super(description);
    this.type = type;
    this.details = details;
  }

  toJSON() {
    return { type: this.type, description: this.message, ...this.details };
  }
}

export function assert(
  condition,
  type = "invalidArguments",
  description = type,
  details = {},
) {
  if (!condition) throw new JmapError(type, description, details);
}

export function errorJSON(error, stage = "request") {
  if (error instanceof JmapError) return error.toJSON();
  // Do not return message bodies, SQL, provider responses, or secrets to callers.
  logEvent("internal_error", { stage }, error);
  return { type: "serverFail", description: "An internal operation failed." };
}
