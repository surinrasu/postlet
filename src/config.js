export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
export const SUBMISSION = "urn:ietf:params:jmap:submission";
export const MAX_API_BYTES = 2 * 1024 * 1024;
export const MAX_OBJECTS = 256;
export const MAX_SEND_BYTES = 5 * 1024 * 1024;
export const TYPES = [
  "Mailbox",
  "Email",
  "Thread",
  "Identity",
  "EmailSubmission",
];
export const ROLES = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

/** @param {{MAX_MESSAGE_BYTES: (string|undefined)}} env */
export function maxMessageBytes(env) {
  const n = Number(env.MAX_MESSAGE_BYTES || 10485760);
  return Number.isSafeInteger(n) && n > 0
    ? Math.min(n, 25 * 1024 * 1024)
    : 10485760;
}

/**
 * @param {{ACCOUNT_ID: (string|undefined), MAIL_NAME: (string|undefined), MAIL_ADDRESS: string, SEND_ENABLED: string, MAX_MESSAGE_BYTES: (string|undefined)}} env
 * @param {string} origin
 * @param {!Array<string>} scopes
 */
export function session(env, origin, scopes) {
  const canWrite = scopes.includes("write");
  const canSend = scopes.includes("send") && env.SEND_ENABLED === "true";
  const mail = {
    maxMailboxesPerEmail: null,
    maxMailboxDepth: null,
    maxSizeMailboxName: 255,
    maxSizeAttachmentsPerEmail: MAX_SEND_BYTES,
    emailQuerySortOptions: [
      "receivedAt",
      "sentAt",
      "size",
      "from",
      "to",
      "subject",
      "hasKeyword",
      "allInThreadHaveKeyword",
      "someInThreadHaveKeyword",
    ],
    mayCreateTopLevelMailbox: canWrite,
  };
  const accountCapabilities = { [CORE]: {}, [MAIL]: mail };
  if (canSend)
    accountCapabilities[SUBMISSION] = {
      maxDelayedSend: 0,
      submissionExtensions: {},
    };
  const capabilities = {
    [CORE]: {
      maxSizeUpload: maxMessageBytes(env),
      maxConcurrentUpload: 4,
      maxSizeRequest: MAX_API_BYTES,
      maxConcurrentRequests: 8,
      maxCallsInRequest: 32,
      maxObjectsInGet: MAX_OBJECTS,
      maxObjectsInSet: MAX_OBJECTS,
      collationAlgorithms: ["i;unicode-casemap"],
    },
    [MAIL]: {},
  };
  if (canSend) capabilities[SUBMISSION] = {};
  const accountId = env.ACCOUNT_ID || "personal";
  return {
    capabilities,
    accounts: {
      [accountId]: {
        name: env.MAIL_NAME || "Postlet",
        isPersonal: true,
        isReadOnly: !canWrite,
        accountCapabilities,
      },
    },
    primaryAccounts: Object.fromEntries(
      Object.keys(accountCapabilities).map((key) => [key, accountId]),
    ),
    username: env.MAIL_ADDRESS,
    apiUrl: `${origin}/jmap`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}`,
    eventSourceUrl: `${origin}/jmap/events?types={types}&closeafter={closeafter}&ping={ping}`,
    state: `postlet-1-${canWrite ? "w" : "r"}-${canSend ? "s" : "n"}`,
  };
}
