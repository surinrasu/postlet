import { isObject } from "./util.js";

// Only fixed SQL fragments are interpolated. Every client value is bound.
function condition(filter, params, depth = 0) {
  if (filter == null) return "1";
  if (!isObject(filter) || depth > 16) return null;
  if (filter.operator !== undefined) {
    if (
      !["AND", "OR", "NOT"].includes(filter.operator) ||
      !Array.isArray(filter.conditions) ||
      !filter.conditions.length ||
      filter.conditions.length > 32
    )
      return null;
    const parts = filter.conditions.map((child) =>
      condition(child, params, depth + 1),
    );
    if (parts.includes(null)) return null;
    return `${filter.operator === "NOT" ? "NOT " : ""}(${parts.join(filter.operator === "AND" ? " AND " : " OR ")})`;
  }
  const parts = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "inMailbox" && typeof value === "string") {
      parts.push(
        "EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.email_id=e.id AND m.mailbox_id=?)",
      );
      params.push(value);
    } else if (
      ["hasKeyword", "notKeyword"].includes(key) &&
      typeof value === "string"
    ) {
      parts.push(
        `${key === "notKeyword" ? "NOT " : ""}EXISTS (SELECT 1 FROM json_each(e.keywords) WHERE key=? AND value=1)`,
      );
      params.push(value);
    } else if (key === "hasAttachment" && typeof value === "boolean") {
      parts.push("e.has_attachment=?");
      params.push(Number(value));
    } else if (
      ["minSize", "maxSize"].includes(key) &&
      Number.isInteger(value) &&
      value >= 0
    ) {
      parts.push(`e.size ${key === "minSize" ? ">=" : "<"} ?`);
      params.push(value);
    } else if (
      ["before", "after"].includes(key) &&
      typeof value === "string" &&
      Number.isFinite(Date.parse(value))
    ) {
      parts.push(`e.received_at ${key === "before" ? "<" : ">="} ?`);
      params.push(new Date(value).toISOString().toLowerCase());
    } else if (key === "subject" && typeof value === "string") {
      parts.push("instr(e.subject,?)>0");
      params.push(value.toLocaleLowerCase());
    } else if (
      ["text", "body"].includes(key) &&
      typeof value === "string" &&
      value.length <= 256
    ) {
      const full = [...value].length >= 3;
      parts.push(
        `e.id IN (SELECT email_id FROM email_search WHERE kind=? AND ${full ? "content MATCH ?" : "instr(lower(content),lower(?))>0"})`,
      );
      params.push(
        key === "body" ? "body" : "all",
        full ? `"${value.replaceAll('"', '""')}"` : value,
      );
    } else return null;
  }
  return parts.length ? `(${parts.join(" AND ")})` : "1";
}

export function indexedEmailQuery(store, args) {
  if (args.collapseThreads) return null;
  const params = [];
  const where = condition(args.filter, params);
  if (where === null) return null;
  const sort = args.sort ?? [{ property: "receivedAt", isAscending: false }];
  if (!Array.isArray(sort) || sort.length > 8) return null;
  const columns = {
    receivedAt: "received_at",
    sentAt: "sent_at",
    size: "size",
    subject: "subject",
    from: "sender",
    to: "recipient",
    id: "id",
  };
  const order = [];
  for (const spec of sort) {
    if (
      !isObject(spec) ||
      !Object.hasOwn(columns, spec.property) ||
      (spec.isAscending != null && typeof spec.isAscending !== "boolean") ||
      (spec.collation != null && spec.collation !== "i;unicode-casemap")
    )
      return null;
    order.push(
      `e.${columns[spec.property]} ${spec.isAscending === false ? "DESC" : "ASC"}`,
    );
  }
  order.push("e.id ASC");
  const base = `FROM email_index e WHERE ${where}`;
  const total = store.sql
    .exec(`SELECT count(*) AS n ${base}`, ...params)
    .one().n;
  return {
    total: Number(total),
    ids: (position = 0, limit = total) =>
      store.sql
        .exec(
          `SELECT e.id ${base} ORDER BY ${order.join(",")} LIMIT ? OFFSET ?`,
          ...params,
          limit,
          position,
        )
        .toArray()
        .map((row) => row.id),
  };
}
