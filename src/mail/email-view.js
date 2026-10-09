import { maxMessageBytes } from "../config.js";
import { assert } from "../errors.js";
import { headerProperty } from "../mime.js";
import { selectProperties, truncateUtf8 } from "../util.js";

const EMAIL_DEFAULTS = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
];
const BODY_DEFAULTS = [
  "partId",
  "blobId",
  "size",
  "name",
  "type",
  "charset",
  "disposition",
  "cid",
  "language",
  "location",
];

// Projections also accept prepared Email/parse data, before a thread is assigned.
/** @param {*} service @param {!Object<string, *>} email @param {!Object<string, *>} args */
export async function emailView(service, email, args) {
  const result = selectProperties(email, args.properties, EMAIL_DEFAULTS);
  for (const key of Object.keys(result))
    if (key.startsWith("_")) delete result[key];
  for (const key of args.properties || [])
    if (key.startsWith("header:"))
      result[key] = headerProperty(email.headers, key);
  const partView = (part) => {
    const object = {};
    for (const key of args.bodyProperties || BODY_DEFAULTS) {
      if (key.startsWith("header:"))
        object[key] = headerProperty(part.headers, key);
      else if (Object.hasOwn(part, key)) object[key] = part[key];
    }
    if (part.subParts) object.subParts = part.subParts.map(partView);
    return object;
  };
  for (const key of ["textBody", "htmlBody", "attachments"])
    if (result[key]) result[key] = result[key].map(partView);
  if (result.bodyStructure)
    result.bodyStructure = partView(result.bodyStructure);
  if ((args.properties || EMAIL_DEFAULTS).includes("bodyValues")) {
    const wanted = new Set();
    if (args.fetchAllBodyValues) {
      const walk = (part) => {
        if (part.type.startsWith("text/") && part.partId)
          wanted.add(part.partId);
        for (const child of part.subParts || []) walk(child);
      };
      walk(email.bodyStructure);
    }
    if (args.fetchTextBodyValues)
      for (const part of email.textBody)
        if (part.type.startsWith("text/")) wanted.add(part.partId);
    if (args.fetchHTMLBodyValues)
      for (const part of email.htmlBody)
        if (part.type.startsWith("text/")) wanted.add(part.partId);
    result.bodyValues = {};
    if (wanted.size) {
      const bodyBlob = await service.getBlob(email._bodiesBlobId);
      assert(bodyBlob, "serverFail", "Missing body data.");
      const bodies = await bodyBlob.json();
      const limit = args.maxBodyValueBytes ?? 1048576;
      assert(
        Number.isInteger(limit) &&
          limit >= 0 &&
          limit <= maxMessageBytes(service.env),
      );
      for (const partId of wanted)
        if (bodies[partId])
          result.bodyValues[partId] = {
            ...bodies[partId],
            ...truncateUtf8(bodies[partId].value, limit),
          };
    }
  }
  return result;
}
