// Shared JSDoc records. These describe persisted data and module boundaries;
// request validation still runs at the HTTP/JMAP boundary.

/**
 * @typedef {{id: string, scopes: !Array<string>, requestId: (string|undefined), legacyAllowed: (boolean|undefined)}}
 */
export let AuthContext;

/** @typedef {{name: (?string|undefined), email: string}} */
export let MailAddress;

/** @typedef {{name: string, value: string}} */
export let Header;

/**
 * @typedef {{partId: ?string, blobId: ?string, size: number, name: ?string,
 * type: string, charset: ?string, disposition: ?string, cid: ?string,
 * language: ?Array<string>, location: ?string, headers: !Array<!Header>,
 * subParts: (Array<!BodyPart>|undefined)}}
 */
export let BodyPart;

/**
 * Persisted Email metadata. Body text lives in R2, referenced by _bodiesBlobId;
 * internal fields are omitted by the JMAP projection.
 * @typedef {{id: string, blobId: string, threadId: string, size: number,
 * receivedAt: string, sentAt: ?string, subject: string, preview: string,
 * mailboxIds: !Object<string, boolean>, keywords: !Object<string, boolean>,
 * from: ?Array<!MailAddress>, to: ?Array<!MailAddress>,
 * cc: ?Array<!MailAddress>, bcc: ?Array<!MailAddress>,
 * sender: ?Array<!MailAddress>, replyTo: ?Array<!MailAddress>,
 * messageId: ?Array<string>, inReplyTo: ?Array<string>, references: ?Array<string>,
 * headers: !Array<!Header>, hasAttachment: boolean, bodyStructure: !BodyPart,
 * textBody: !Array<!BodyPart>, htmlBody: !Array<!BodyPart>,
 * attachments: !Array<!BodyPart>, _bodiesBlobId: string}}
 */
export let StoredEmail;

/**
 * Before commit, mailbox references still need validation and threadId has not
 * been assigned. insertPrepared performs both inside a synchronous transaction.
 * @typedef {{email: !Object<string, *>, search: !Object<string, string>}}
 */
export let PreparedEmail;

/**
 * R2 recovery ticket. rawKey is absent only on receipts from older releases.
 * @typedef {{id: string, blobId: string, rawKey: (string|undefined), size: number,
 * createdAt: number, envelope: {from: string, to: string}}}
 */
export let InboundTicket;

/** @typedef {{email: string, parameters: (?Object<string, string>|undefined)}} */
export let EnvelopeAddress;

/**
 * _recipients values are sending, accepted, rejected or unknown. Missing means
 * unattempted. An unknown outcome must never trigger an automatic resend.
 * undoStatus is pending, final or canceled, as exposed by JMAP.
 * @typedef {{id: string, identityId: string, emailId: string, threadId: string,
 * envelope: {mailFrom: !EnvelopeAddress, rcptTo: !Array<!EnvelopeAddress>},
 * sendAt: string, undoStatus: string,
 * deliveryStatus: ?Object<string, {smtpReply: string, delivered: string, displayed: string}>,
 * dsnBlobIds: !Array<string>, mdnBlobIds: !Array<string>,
 * _blobId: string, _recipients: !Object<string, string>,
 * _providerMessageId: (?string|undefined)}}
 */
export let Submission;

/**
 * Result maps start as null-prototype dictionaries and become null when empty.
 * @typedef {{accountId: string, oldState: string, newState: string,
 * created: ?Object<string, *>, updated: ?Object<string, *>, destroyed: ?Array<string>,
 * notCreated: ?Object<string, *>, notUpdated: ?Object<string, *>, notDestroyed: ?Object<string, *>}}
 */
export let SetResult;
