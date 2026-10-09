import { diffIds } from "./diff.js";
import { indexedEmailQuery } from "./email-query.js";
import { assert, JmapError } from "./errors.js";

export { diffIds } from "./diff.js";

import { isObject, sha256 } from "./util.js";

function includes(value, search) {
  assert(typeof search === "string", "unsupportedFilter");
  return String(value || "")
    .toLocaleLowerCase()
    .includes(search.toLocaleLowerCase());
}

/**
 * @param {string} type
 * @param {?Object<string, *>} filter
 * @param {*} store
 * @param {!Array<!Object<string, *>>} emails
 * @param {number=} depth
 * @return {function(!Object<string, *>):boolean}
 */
function filterPredicate(type, filter, store, emails, depth = 0) {
  if (filter == null) return () => true;
  assert(isObject(filter) && depth <= 16, "unsupportedFilter");
  if (filter.operator !== undefined) {
    assert(
      ["AND", "OR", "NOT"].includes(filter.operator) &&
        Array.isArray(filter.conditions) &&
        filter.conditions.length > 0 &&
        filter.conditions.length <= 32,
      "unsupportedFilter",
    );
    const children = filter.conditions.map((child) =>
      filterPredicate(type, child, store, emails, depth + 1),
    );
    return (object) =>
      filter.operator === "AND"
        ? children.every((child) => child(object))
        : filter.operator === "OR"
          ? children.some((child) => child(object))
          : !children.some((child) => child(object));
  }
  const predicates = Object.entries(filter).map(([key, value]) => {
    if (type === "Email") {
      if (["text", "body"].includes(key)) {
        const matches = store.searchIds(value, key === "body" ? "body" : "all");
        return (email) => matches.has(email.id);
      }
      if (key === "inMailbox") {
        assert(typeof value === "string", "unsupportedFilter");
        return (e) => Boolean(e.mailboxIds[value]);
      }
      if (key === "inMailboxOtherThan") {
        assert(Array.isArray(value), "unsupportedFilter");
        return (e) =>
          Object.keys(e.mailboxIds).some((id) => !value.includes(id));
      }
      if (["before", "after"].includes(key)) {
        assert(
          typeof value === "string" && Number.isFinite(Date.parse(value)),
          "unsupportedFilter",
        );
        return (e) =>
          key === "before"
            ? Date.parse(e.receivedAt) < Date.parse(value)
            : Date.parse(e.receivedAt) >= Date.parse(value);
      }
      if (["minSize", "maxSize"].includes(key)) {
        assert(Number.isInteger(value) && value >= 0, "unsupportedFilter");
        return (e) => (key === "minSize" ? e.size >= value : e.size < value);
      }
      if (["hasKeyword", "notKeyword"].includes(key)) {
        assert(typeof value === "string", "unsupportedFilter");
        return (e) =>
          key === "hasKeyword"
            ? Boolean(e.keywords[value])
            : !e.keywords[value];
      }
      if (key === "hasAttachment") {
        assert(typeof value === "boolean", "unsupportedFilter");
        return (e) => e.hasAttachment === value;
      }
      if (["from", "to", "cc", "bcc"].includes(key))
        return (e) =>
          includes(
            (e[key] || []).map((a) => `${a.name || ""} ${a.email}`).join(" "),
            value,
          );
      if (key === "subject") return (e) => includes(e.subject, value);
      if (key === "header") {
        assert(
          Array.isArray(value) &&
            [1, 2].includes(value.length) &&
            value.every((x) => typeof x === "string"),
          "unsupportedFilter",
        );
        return (e) =>
          e.headers.some(
            (h) =>
              h.name.toLowerCase() === value[0].toLowerCase() &&
              (value.length === 1 || includes(h.value, value[1])),
          );
      }
      if (
        [
          "allInThreadHaveKeyword",
          "someInThreadHaveKeyword",
          "noneInThreadHaveKeyword",
        ].includes(key)
      ) {
        assert(typeof value === "string", "unsupportedFilter");
        const threads = new Map();
        for (const email of emails) {
          const status = threads.get(email.threadId) || {
            all: true,
            some: false,
          };
          status.all &&= Boolean(email.keywords[value]);
          status.some ||= Boolean(email.keywords[value]);
          threads.set(email.threadId, status);
        }
        return (e) => {
          const thread = threads.get(e.threadId);
          return key === "allInThreadHaveKeyword"
            ? thread.all
            : key === "someInThreadHaveKeyword"
              ? thread.some
              : !thread.some;
        };
      }
    }
    if (type === "Mailbox") {
      if (key === "parentId") return (m) => m.parentId === value;
      if (key === "name") return (m) => includes(m.name, value);
      if (key === "role") return (m) => m.role === value;
      if (key === "hasAnyRole") {
        assert(typeof value === "boolean", "unsupportedFilter");
        return (m) => Boolean(m.role) === value;
      }
      if (key === "isSubscribed") {
        assert(typeof value === "boolean", "unsupportedFilter");
        return (m) => m.isSubscribed === value;
      }
    }
    if (type === "EmailSubmission") {
      if (["identityIds", "emailIds", "threadIds"].includes(key)) {
        assert(Array.isArray(value), "unsupportedFilter");
        return (s) => value.includes(s[key.slice(0, -1)]);
      }
      if (key === "undoStatus") return (s) => s.undoStatus === value;
      if (["before", "after"].includes(key)) {
        assert(
          typeof value === "string" && Number.isFinite(Date.parse(value)),
          "unsupportedFilter",
        );
        return (s) =>
          key === "before"
            ? Date.parse(s.sendAt) < Date.parse(value)
            : Date.parse(s.sendAt) >= Date.parse(value);
      }
    }
    throw new JmapError(
      "unsupportedFilter",
      `Unsupported ${type} filter: ${key}`,
    );
  });
  return (object) => predicates.every((predicate) => predicate(object));
}

/** @param {string} type @param {?Array<!Object<string,*>>} sort @return {function(!Object<string,*>,!Object<string,*>):number} */
function comparator(type, sort, objects = []) {
  const allowed =
    type === "Email"
      ? [
          "receivedAt",
          "sentAt",
          "size",
          "from",
          "to",
          "subject",
          "id",
          "hasKeyword",
          "allInThreadHaveKeyword",
          "someInThreadHaveKeyword",
        ]
      : type === "Mailbox"
        ? ["name", "sortOrder", "parent/name"]
        : ["emailId", "threadId", "sentAt"];
  const defaults =
    type === "Email"
      ? [{ property: "receivedAt", isAscending: false }]
      : type === "Mailbox"
        ? [
            { property: "sortOrder", isAscending: true },
            { property: "name", isAscending: true },
          ]
        : [{ property: "sentAt", isAscending: false }];
  const entries = sort ?? defaults;
  assert(Array.isArray(entries) && entries.length <= 8, "unsupportedSort");
  for (const entry of entries)
    assert(
      isObject(entry) &&
        allowed.includes(entry.property) &&
        (entry.isAscending == null || typeof entry.isAscending === "boolean") &&
        (entry.collation == null || entry.collation === "i;unicode-casemap"),
      "unsupportedSort",
    );
  const threadKeywords = new Map();
  for (const spec of entries) {
    if (
      ![
        "hasKeyword",
        "allInThreadHaveKeyword",
        "someInThreadHaveKeyword",
      ].includes(spec.property)
    )
      continue;
    assert(typeof spec.keyword === "string", "unsupportedSort");
    for (const object of objects) {
      const key = `${spec.keyword}:${object.threadId}`;
      const status = threadKeywords.get(key) || { all: true, some: false };
      status.all &&= Boolean(object.keywords?.[spec.keyword]);
      status.some ||= Boolean(object.keywords?.[spec.keyword]);
      threadKeywords.set(key, status);
    }
  }
  const key = (object, spec) => {
    if (spec.property === "allInThreadHaveKeyword")
      return (
        threadKeywords.get(`${spec.keyword}:${object.threadId}`)?.all || false
      );
    if (spec.property === "someInThreadHaveKeyword")
      return (
        threadKeywords.get(`${spec.keyword}:${object.threadId}`)?.some || false
      );
    if (type === "EmailSubmission" && spec.property === "sentAt")
      return object.sendAt;
    if (spec.property === "hasKeyword") {
      assert(typeof spec.keyword === "string", "unsupportedSort");
      return Boolean(object.keywords?.[spec.keyword]);
    }
    if (["from", "to"].includes(spec.property))
      return (
        object[spec.property]?.[0]?.name ||
        object[spec.property]?.[0]?.email ||
        ""
      ).toLowerCase();
    return typeof object[spec.property] === "string"
      ? object[spec.property].toLowerCase()
      : (object[spec.property] ?? "");
  };
  return (a, b) => {
    for (const spec of entries) {
      const left = key(a, spec),
        right = key(b, spec);
      const diff = left < right ? -1 : left > right ? 1 : 0;
      if (diff) return spec.isAscending === false ? -diff : diff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** @param {*} store @param {string} type @param {!Object<string,*>} args @return {!Array<!Object<string,*>>} */
export function matchingObjects(store, type, args) {
  const objects = store.all(type);
  const predicate = filterPredicate(
    type,
    args.filter,
    store,
    type === "Email" ? objects : [],
  );
  const compare = comparator(type, args.sort, objects);
  let matches = objects.filter(predicate);
  if (type === "Mailbox") {
    const byId = new Map(objects.map((object) => [object.id, object]));
    const ancestors = (mailbox) => {
      const path = [mailbox];
      for (
        let parent = mailbox.parentId;
        parent;
        parent = byId.get(parent)?.parentId
      )
        path.unshift(byId.get(parent));
      return path;
    };
    if (args.filterAsTree)
      matches = matches.filter((mailbox) =>
        ancestors(mailbox).every(predicate),
      );
    if (args.sortAsTree)
      matches.sort((a, b) => {
        const left = ancestors(a),
          right = ancestors(b);
        let i = 0;
        while (
          i < left.length &&
          i < right.length &&
          left[i].id === right[i].id
        )
          i++;
        return i === left.length || i === right.length
          ? left.length - right.length
          : compare(left[i], right[i]);
      });
    else matches.sort(compare);
  } else matches.sort(compare);
  if (type !== "Email" || !args.collapseThreads) return matches;
  const threads = new Set();
  return matches.filter((email) => {
    if (threads.has(email.threadId)) return false;
    threads.add(email.threadId);
    return true;
  });
}

/** @param {*} store @param {string} type @param {!Object<string,*>} args */
export async function query(store, type, args, needAllIds = false) {
  assert(args.position == null || Number.isInteger(args.position));
  assert(
    args.limit == null || (Number.isInteger(args.limit) && args.limit >= 0),
  );
  assert(args.anchorOffset == null || Number.isInteger(args.anchorOffset));
  const indexed = type === "Email" ? indexedEmailQuery(store, args) : null;
  // Large ordinary queries page in SQL. Small queries retain compact ID-only
  // snapshots for queryChanges; no MIME/header metadata is loaded on this path.
  const ids = indexed
    ? needAllIds || indexed.total <= 20000 || args.anchor != null
      ? indexed.ids()
      : null
    : matchingObjects(store, type, args).map((object) => object.id);
  const total = indexed?.total ?? ids.length;
  const state = store.state(type);
  let position = args.position || 0;
  if (args.anchor != null) {
    const anchor = ids.indexOf(args.anchor);
    assert(anchor >= 0, "anchorNotFound");
    position = anchor + (args.anchorOffset || 0);
  } else if (position < 0) position = Math.max(0, total + position);
  position = Math.max(0, position);
  const pageIds = indexed
    ? indexed.ids(position, Math.min(args.limit ?? 256, 1000))
    : ids.slice(position, position + Math.min(args.limit ?? 256, 1000));
  const signature = await sha256(
    JSON.stringify([
      type,
      args.filter ?? null,
      args.sort ?? null,
      args.collapseThreads ?? false,
      args.filterAsTree ?? false,
      args.sortAsTree ?? false,
    ]),
  );
  const canCalculateChanges = total <= 20000;
  const queryState = `q${await sha256(`${signature}:${canCalculateChanges ? JSON.stringify(ids) : state}`)}`;
  if (canCalculateChanges)
    store.sql.exec(
      "INSERT OR REPLACE INTO query_snapshots(id,type,signature,ids,created_at) VALUES(?,?,?,?,?)",
      queryState,
      type,
      signature,
      JSON.stringify(ids),
      Date.now(),
    );
  const result = {
    queryState,
    canCalculateChanges,
    position,
    ids: pageIds,
  };
  if (args.calculateTotal) result.total = total;
  if (type === "Email") result.collapseThreads = args.collapseThreads ?? false;
  return { result, allIds: ids, signature };
}

/** @param {*} store @param {string} type @param {!Object<string,*>} args */
export async function queryChanges(store, type, args) {
  const old = store.sql
    .exec(
      "SELECT * FROM query_snapshots WHERE id=? AND type=?",
      args.sinceQueryState,
      type,
    )
    .toArray()[0];
  assert(old, "cannotCalculateChanges");
  const next = await query(
    store,
    type,
    {
      ...args,
      position: 0,
      limit: 0,
      anchor: null,
      calculateTotal: true,
    },
    true,
  );
  assert(
    old.signature === next.signature,
    "cannotCalculateChanges",
    "Query parameters changed.",
  );
  const diff = diffIds(JSON.parse(old.ids), next.allIds);
  if (args.maxChanges != null)
    assert(
      diff.removed.length + diff.added.length <= args.maxChanges,
      "tooManyChanges",
    );
  // Returning the complete diff also satisfies upToId: it is an optimization hint.
  return {
    oldQueryState: args.sinceQueryState,
    newQueryState: next.result.queryState,
    total: next.allIds.length,
    ...diff,
    ...(type === "Email"
      ? { collapseThreads: args.collapseThreads ?? false }
      : {}),
  };
}
