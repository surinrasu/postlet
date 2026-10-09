import PostalMime, { addressParser, decodeWords } from "postal-mime";
import { assert, JmapError } from "./errors.js";
import {
  base64,
  encoder,
  isObject,
  newId,
  sha256,
  validAddress,
} from "./util.js";

const PARSER_OPTIONS = {
  maxNestingDepth: 32,
  maxHeadersSize: 131072,
  maxPartCount: 256,
  maxRfc822NestingDepth: 0,
  forceRfc822Attachments: true,
};

export function messageIds(value) {
  if (!value) return null;
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]);
  return ids.length ? ids : null;
}

function addresses(value) {
  if (!value) return null;
  return (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    entry.group
      ? addresses(entry.group) || []
      : [{ name: entry.name || null, email: entry.address }],
  );
}

function headerValues(headers, name) {
  return headers
    .filter((header) => header.name.toLowerCase() === name.toLowerCase())
    .map((header) => header.value);
}

export function headerProperty(headers, property) {
  const match =
    /^header:([^:]+)(?::(asRaw|asText|asAddresses|asGroupedAddresses|asMessageIds|asDate|asURLs))?(?::(all))?$/.exec(
      property,
    );
  assert(match, "invalidArguments", "Invalid header property.");
  const [, name, form = "asRaw", all] = match;
  const convert = (value) => {
    if (form === "asRaw") return value;
    if (form === "asText")
      return decodeWords(value)
        .replace(/\r?\n[ \t]+/g, " ")
        .trim();
    if (form === "asAddresses")
      return addresses(addressParser(value, { flatten: true }));
    if (form === "asGroupedAddresses")
      return addressParser(value).map((entry) =>
        entry.group
          ? { name: entry.name, addresses: addresses(entry.group) }
          : { name: null, addresses: addresses(entry) },
      );
    if (form === "asMessageIds") return messageIds(value);
    if (form === "asDate")
      return Number.isFinite(Date.parse(value))
        ? new Date(value).toISOString()
        : null;
    if (form === "asURLs")
      return [...value.matchAll(/<([^<>]+)>/g)].map((item) => item[1]);
    return null;
  };
  const values = headerValues(headers, name);
  return all
    ? values.map(convert)
    : values.length
      ? convert(values.at(-1))
      : null;
}

/** Parse once, preserve the MIME tree, and persist decoded parts separately. */
export async function parseMessage(raw, putBlob) {
  const parser = new PostalMime(PARSER_OPTIONS);
  let parsed;
  try {
    parsed = await parser.parse(raw);
  } catch {
    throw new JmapError(
      "invalidEmail",
      "MIME parsing failed or exceeded the depth, part, or header limit.",
    );
  }
  // postal-mime 4.0.5's tree is internal. The exact dependency is pinned and the
  // integration tests exercise nested alternatives, attachments, and charsets.
  if (
    !("root" in parser) ||
    !parser.root ||
    typeof parser.root !== "object" ||
    !("contentType" in parser.root) ||
    !("childNodes" in parser.root) ||
    !Array.isArray(parser.root.childNodes)
  )
    throw new JmapError("serverFail", "Unsupported MIME parser layout.");
  const bodies = {};
  const allParts = [];
  const visit = async (node, partId) => {
    const multipart = Boolean(node.contentType.multipart);
    const type = node.contentType.parsed.value || "text/plain";
    const disposition = node.contentDisposition?.parsed?.value || null;
    const name =
      node.contentDisposition?.parsed?.params?.filename ||
      node.contentType.parsed.params?.name ||
      null;
    const content = new Uint8Array(node.content || new ArrayBuffer(0));
    const part = {
      partId: multipart ? null : partId,
      blobId: multipart ? null : await putBlob(content, type),
      size: multipart ? 0 : content.byteLength,
      headers: node.headers.map((h) => ({
        name: h.originalKey || h.key,
        value: h.value,
      })),
      name: name ? decodeWords(name) : null,
      type,
      charset:
        node.contentType.parsed.params?.charset ||
        (type.startsWith("text/") ? "us-ascii" : null),
      disposition,
      cid: node.contentId?.replace(/^<|>$/g, "") || null,
      language:
        node.headers
          .find((h) => h.key === "content-language")
          ?.value.split(",")
          .map((x) => x.trim()) || null,
      location:
        node.headers.find((h) => h.key === "content-location")?.value || null,
    };
    if (multipart) {
      part.subParts = [];
      for (let i = 0; i < node.childNodes.length; i++)
        part.subParts.push(
          await visit(node.childNodes[i], `${partId}.${i + 1}`),
        );
    } else {
      if (type.startsWith("text/"))
        bodies[partId] = {
          value: node.getTextContent(),
          isEncodingProblem: false,
          isTruncated: false,
        };
      allParts.push(part);
    }
    return part;
  };
  const bodyStructure = await visit(parser.root, "1");
  const display = (part, preferred) => {
    if (part.disposition === "attachment") return [];
    if (part.subParts) {
      const candidates = part.subParts.map((child) =>
        display(child, preferred),
      );
      if (part.type === "multipart/alternative")
        return (
          candidates.findLast((list) =>
            list.some((x) => x.type === preferred),
          ) ||
          candidates.findLast((list) => list.length) ||
          []
        );
      if (part.type === "multipart/related") return candidates[0] || [];
      return candidates.flat();
    }
    return ["text/plain", "text/html"].includes(part.type) ||
      /^(image|audio|video)\//.test(part.type)
      ? [part]
      : [];
  };
  const textBody = display(bodyStructure, "text/plain");
  const htmlBody = display(bodyStructure, "text/html");
  const attachments = allParts.filter((part) => {
    const inText = textBody.includes(part),
      inHtml = htmlBody.includes(part);
    return (
      (!inText && !inHtml) ||
      (/^(image|audio|video)\//.test(part.type) && !(inText && inHtml))
    );
  });
  const text = parsed.text || parsed.html?.replace(/<[^>]*>/g, " ") || "";
  return {
    data: {
      headers: parsed.headers.map((h) => ({
        name: h.originalKey || h.key,
        value: h.value,
      })),
      messageId: messageIds(parsed.messageId),
      inReplyTo: messageIds(parsed.inReplyTo),
      references: messageIds(parsed.references),
      sender: addresses(parsed.sender),
      from: addresses(parsed.from),
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      replyTo: addresses(parsed.replyTo),
      subject: parsed.subject || "",
      sentAt:
        parsed.date && Number.isFinite(Date.parse(parsed.date))
          ? new Date(parsed.date).toISOString()
          : null,
      bodyStructure,
      textBody,
      htmlBody,
      attachments,
      hasAttachment: attachments.length > 0,
      preview: text.replace(/\s+/g, " ").trim().slice(0, 256),
    },
    bodies,
    search: {
      body: text,
      all: [
        parsed.subject,
        parsed.from?.address,
        ...[parsed.to, parsed.cc, parsed.bcc].flatMap((list) =>
          (list || [])
            .flatMap((a) => a.group || [a])
            .map((a) => `${a.name} ${a.address}`),
        ),
        text,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  };
}

function safeHeader(value) {
  assert(
    typeof value === "string" && !/[\r\n\x00]/.test(value),
    "invalidProperties",
    "Header values must not contain line breaks.",
  );
  return value;
}

function encodedWords(value) {
  safeHeader(value);
  if (/^[\x20-\x7e]*$/.test(value) && value.length < 76) return value;
  const chunks = [];
  let chunk = "";
  for (const character of value) {
    if (encoder.encode(chunk + character).length > 36) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map((s) => `=?UTF-8?B?${base64(encoder.encode(s))}?=`)
    .join("\r\n ");
}

export function validateAddresses(list) {
  assert(
    Array.isArray(list) &&
      list.length <= 50 &&
      list.every(
        (a) =>
          isObject(a) &&
          validAddress(a.email) &&
          (a.name == null || typeof a.name === "string"),
      ),
    "invalidProperties",
    "Invalid email address list.",
  );
  for (const address of list) if (address.name) safeHeader(address.name);
}

function formatAddresses(list) {
  validateAddresses(list);
  return list
    .map(
      (a) =>
        `${a.name ? `${encodedWords(a.name).startsWith("=?") ? encodedWords(a.name) : JSON.stringify(a.name)} ` : ""}<${a.email}>`,
    )
    .join(",\r\n ");
}

function formatIds(list) {
  assert(
    Array.isArray(list) &&
      list.every((s) => typeof s === "string" && /^[^<>\s]+$/.test(s)),
    "invalidProperties",
    "Invalid message id.",
  );
  return list.map((s) => `<${s}>`).join(" ");
}

export async function composeMessage(input, env, getBlob) {
  const allowed = new Set([
    "mailboxIds",
    "keywords",
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
    "bodyStructure",
    "bodyValues",
    "textBody",
    "htmlBody",
    "attachments",
  ]);
  for (const property of Object.keys(input))
    assert(
      allowed.has(property) || property.startsWith("header:"),
      "invalidProperties",
      `Unsupported create property: ${property}`,
      { properties: [property] },
    );
  const headers = [];
  const add = (name, value) => headers.push(`${name}: ${value}`);
  add("MIME-Version", "1.0");
  add(
    "Message-ID",
    formatIds(input.messageId || [`${newId("m")}@${env.MAIL_DOMAIN}`]),
  );
  add(
    "Date",
    input.sentAt
      ? new Date(input.sentAt).toUTCString()
      : new Date().toUTCString(),
  );
  add(
    "From",
    formatAddresses(
      input.from || [{ email: env.MAIL_ADDRESS, name: env.MAIL_NAME }],
    ),
  );
  for (const [property, name] of [
    ["sender", "Sender"],
    ["to", "To"],
    ["cc", "Cc"],
    ["bcc", "Bcc"],
    ["replyTo", "Reply-To"],
  ])
    if (input[property]?.length) add(name, formatAddresses(input[property]));
  add("Subject", encodedWords(input.subject || ""));
  for (const [property, name] of [
    ["inReplyTo", "In-Reply-To"],
    ["references", "References"],
  ])
    if (input[property]) add(name, formatIds(input[property]));
  for (const [property, value] of Object.entries(input)) {
    if (!property.startsWith("header:")) continue;
    const match =
      /^header:([A-Za-z0-9-]+)(?::(asText|asRaw|asMessageIds|asAddresses))?$/.exec(
        property,
      );
    assert(match, "invalidProperties", "Unsupported header creation form.");
    const [, name, form = "asRaw"] = match;
    assert(
      !/^(content-|mime-version|bcc|return-path|received|authentication-results|dkim-signature)/i.test(
        name,
      ),
      "invalidProperties",
      "This header is generated by the service.",
    );
    assert(
      !headers.some((header) =>
        header.toLowerCase().startsWith(`${name.toLowerCase()}:`),
      ),
      "invalidProperties",
      "A header was specified twice.",
    );
    add(
      name,
      form === "asText"
        ? encodedWords(value)
        : form === "asMessageIds"
          ? formatIds(value)
          : form === "asAddresses"
            ? formatAddresses(value)
            : safeHeader(value),
    );
  }
  const bodyValues = input.bodyValues || {};
  let parts = 0;
  const build = async (part, depth = 0) => {
    assert(
      isObject(part) && depth < 32 && ++parts <= 256,
      "invalidProperties",
      "Invalid or excessive MIME structure.",
    );
    const type = part.type || "text/plain";
    assert(
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type),
      "invalidProperties",
      "Invalid content type.",
    );
    if (type.startsWith("multipart/")) {
      assert(
        Array.isArray(part.subParts) && part.subParts.length > 0,
        "invalidProperties",
      );
      const boundary = newId("boundary_");
      const children = [];
      for (const child of part.subParts)
        children.push(await build(child, depth + 1));
      return `Content-Type: ${type}; boundary="${boundary}"\r\n\r\n${children.map((child) => `--${boundary}\r\n${child}\r\n`).join("")}--${boundary}--\r\n`;
    }
    let bytes;
    if (part.partId && Object.hasOwn(bodyValues, part.partId)) {
      assert(
        type.startsWith("text/") &&
          typeof bodyValues[part.partId]?.value === "string",
        "invalidProperties",
      );
      bytes = encoder.encode(bodyValues[part.partId].value);
    } else if (part.blobId) {
      const blob = await getBlob(part.blobId);
      assert(blob, "blobNotFound", "Unknown body blob.");
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else
      throw new JmapError(
        "invalidProperties",
        "Every leaf body part requires bodyValues or a blobId.",
      );
    const lines = [
      `Content-Type: ${type}${type.startsWith("text/") && part.partId ? '; charset="utf-8"' : part.charset ? `; charset="${safeHeader(part.charset).replaceAll('"', "")}"` : ""}`,
      "Content-Transfer-Encoding: base64",
    ];
    if (part.disposition || part.name) {
      const disposition = part.disposition || "attachment";
      assert(
        ["inline", "attachment"].includes(disposition),
        "invalidProperties",
      );
      lines.push(
        `Content-Disposition: ${disposition}${part.name ? `; filename*=UTF-8''${encodeURIComponent(safeHeader(part.name)).replaceAll("'", "%27")}` : ""}`,
      );
    }
    if (part.cid) {
      assert(/^[^<>\s]+$/.test(part.cid), "invalidProperties");
      lines.push(`Content-ID: <${part.cid}>`);
    }
    if (part.language) {
      assert(Array.isArray(part.language), "invalidProperties");
      lines.push(`Content-Language: ${safeHeader(part.language.join(", "))}`);
    }
    if (part.location)
      lines.push(`Content-Location: ${safeHeader(part.location)}`);
    return `${lines.join("\r\n")}\r\n\r\n${
      base64(bytes)
        .match(/.{1,76}/g)
        ?.join("\r\n") || ""
    }\r\n`;
  };
  let structure = input.bodyStructure;
  if (structure)
    assert(
      !input.textBody && !input.htmlBody && !input.attachments,
      "invalidProperties",
      "bodyStructure and body convenience properties are mutually exclusive.",
    );
  else {
    const text = input.textBody || [],
      html = input.htmlBody || [],
      attachments = input.attachments || [];
    assert(
      Array.isArray(text) &&
        text.length <= 1 &&
        Array.isArray(html) &&
        html.length <= 1 &&
        Array.isArray(attachments),
      "invalidProperties",
    );
    const alternatives = [
      ...text.map((p) => ({ ...p, type: "text/plain" })),
      ...html.map((p) => ({ ...p, type: "text/html" })),
    ];
    const body =
      alternatives.length > 1
        ? { type: "multipart/alternative", subParts: alternatives }
        : alternatives[0];
    const mixed = [
      ...(body ? [body] : []),
      ...attachments.map((p) => ({ disposition: "attachment", ...p })),
    ];
    if (!mixed.length) {
      bodyValues.empty = { value: "" };
      mixed.push({ type: "text/plain", partId: "empty" });
    }
    structure =
      mixed.length > 1
        ? { type: "multipart/mixed", subParts: mixed }
        : mixed[0];
  }
  return encoder.encode(`${headers.join("\r\n")}\r\n${await build(structure)}`);
}

export async function blobId(bytes) {
  return `b${await sha256(bytes)}`;
}

/** Remove Bcc only from the top-level header block, preserving original bytes. */
export function withoutBcc(raw) {
  let boundary = -1;
  for (let i = 0; i < raw.length - 3; i++) {
    if (
      raw[i] === 13 &&
      raw[i + 1] === 10 &&
      raw[i + 2] === 13 &&
      raw[i + 3] === 10
    ) {
      boundary = i;
      break;
    }
  }
  assert(
    boundary >= 0,
    "invalidEmail",
    "Message headers must use CRLF before sending.",
  );
  const chunks = [];
  let start = 0,
    skip = false;
  for (let end = 0; end <= boundary; end++) {
    if (raw[end] !== 13 || raw[end + 1] !== 10) continue;
    if (raw[start] !== 32 && raw[start] !== 9) {
      skip =
        (raw[start] | 32) === 98 &&
        (raw[start + 1] | 32) === 99 &&
        (raw[start + 2] | 32) === 99 &&
        raw[start + 3] === 58;
    }
    if (!skip) chunks.push(raw.subarray(start, end + 2));
    start = end + 2;
    end++;
  }
  chunks.push(raw.subarray(boundary + 2));
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
