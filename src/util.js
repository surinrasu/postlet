import { assert, JmapError } from "./errors.js";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

/** @param {string|!Uint8Array|!ArrayBuffer} value @return {!Promise<string>} */
export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}

/** @param {string} prefix @return {string} */
export function newId(prefix) {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function own(object, key) {
  return Object.hasOwn(object, key);
}

export function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

export function validAddress(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/.test(value)
  );
}

export function isoDate(value) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "invalidArguments",
    "Expected an ISO 8601 date.",
  );
  return new Date(value).toISOString();
}

export async function readLimited(stream, limit) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new JmapError(
          "tooLarge",
          "The payload exceeds the configured size limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function truncateUtf8(value, maxBytes) {
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return { value, isTruncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { value: decoder.decode(bytes.subarray(0, end)), isTruncated: true };
}

export function selectProperties(object, properties, defaults) {
  const selected = properties ?? defaults ?? Object.keys(object);
  assert(
    Array.isArray(selected) && selected.every((x) => typeof x === "string"),
  );
  const result = { id: object.id };
  for (const name of selected)
    if (own(object, name)) result[name] = object[name];
  return result;
}

export function applyPatch(original, patch) {
  assert(isObject(patch));
  const result = structuredClone(original);
  const paths = Object.keys(patch);
  for (const path of paths) {
    assert(
      !paths.some((other) => other !== path && path.startsWith(`${other}/`)),
      "invalidPatch",
      "Overlapping patch paths.",
    );
    const keys = path.split("/").map((key) => {
      assert(
        !/~(?![01])/.test(key),
        "invalidPatch",
        "Invalid JSON pointer escape.",
      );
      return key.replaceAll("~1", "/").replaceAll("~0", "~");
    });
    assert(
      keys.every(
        (key) => !["__proto__", "prototype", "constructor"].includes(key),
      ),
      "invalidPatch",
    );
    let target = result;
    for (const key of keys.slice(0, -1)) {
      assert(
        own(target, key) && isObject(target[key]),
        "invalidPatch",
        "Patch parent does not exist.",
      );
      target = target[key];
    }
    const last = keys.at(-1);
    if (patch[path] === null) delete target[last];
    else target[last] = structuredClone(patch[path]);
  }
  return result;
}

export function resolvePointer(value, path) {
  assert(
    typeof path === "string" && (path === "" || path.startsWith("/")),
    "invalidResultReference",
  );
  const parts = path === "" ? [] : path.slice(1).split("/");
  const walk = (current, offset) => {
    if (offset === parts.length) return current;
    const key = parts[offset].replaceAll("~1", "/").replaceAll("~0", "~");
    if (key === "*") {
      assert(Array.isArray(current), "invalidResultReference");
      return current.flatMap((item) => walk(item, offset + 1));
    }
    assert(
      current !== null && typeof current === "object" && own(current, key),
      "invalidResultReference",
    );
    return walk(current[key], offset + 1);
  };
  return walk(value, 0);
}

export function resolveId(id, createdIds) {
  if (typeof id === "string" && id.startsWith("#")) {
    assert(
      own(createdIds, id.slice(1)),
      "invalidArguments",
      "Unknown creation reference.",
    );
    return createdIds[id.slice(1)];
  }
  return id;
}
