import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CORE, MAIL } from "../../src/config.js";
import { sha256 } from "../../src/util.js";
import { workerModules } from "./modules.js";

let mf, directory, stub, storage, bucket;
const root = "http://maintenance.test";
const writer = "local-maintenance-writer-not-a-production-token";
const reader = "local-maintenance-reader-not-a-production-token";
const request = (path, token = writer, body) =>
  mf.dispatchFetch(`${root}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "postlet-maintenance-"));
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "postlet-maintenance",
      modules: [
        { type: "ESModule", path: "tests/integration/maintenance-worker.js" },
        ...workerModules(),
      ],
      compatibilityDate: "2026-10-09",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      cf: false,
      resourcePersistencePath: directory,
      unsafeInspectDurableObjects: true,
      durableObjects: {
        ACCOUNT: { className: "MaintenanceAccount", useSQLite: true },
      },
      r2Buckets: ["MAIL"],
      bindings: {
        ACCOUNT_ID: "personal",
        MAIL_DOMAIN: "example.test",
        MAIL_ADDRESS: "root@example.test",
        SEND_ENABLED: "false",
        AUTH_TOKENS: JSON.stringify([
          {
            id: "writer",
            scopes: ["read", "write"],
            sha256: await sha256(writer),
          },
          { id: "reader", scopes: ["read"], sha256: await sha256(reader) },
        ]),
      },
    }),
  );
  await mf.ready;
  stub = (await mf.getDurableObjectNamespace("ACCOUNT")).getByName("personal");
  await stub.status();
  storage = await mf.unsafeGetDurableObjectStorage(
    "postlet-maintenance",
    "MaintenanceAccount",
    { name: "personal" },
  );
  bucket = await mf.getR2Bucket("MAIL");
});
afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("management endpoints enforce scopes, validate input, and expose a request id", async () => {
  for (const path of ["/admin/storage", "/admin/inbound/retry"]) {
    expect((await request(path, "invalid", {})).status).toBe(401);
    expect((await request(path, reader, {})).status).toBe(403);
  }
  expect(
    (await request("/admin/inbound/retry", writer, { ids: [] })).status,
  ).toBe(400);
  expect(
    (await request("/admin/storage", writer, { apply: "true" })).status,
  ).toBe(400);
  const status = await request("/admin/status", reader);
  expect(status.status).toBe(200);
  expect(status.headers.get("X-Request-ID")).toMatch(/^[a-f0-9-]{36}$/);
  expect((await status.json()).metrics.pendingInbound).toBe(0);
});

test("workerd retries a stalled inbound receipt and preserves idempotent delivery", async () => {
  const t = {
    id: "late",
    blobId: "b_late",
    rawKey: "incoming-raw/late",
    size: 100,
    createdAt: Date.now(),
    envelope: { from: "a@example.com", to: "root@example.test" },
  };
  await stub.enqueueIncoming(t);
  await stub.processIncoming();
  expect((await stub.status()).metrics.pendingInbound).toBe(1);
  await bucket.put(
    t.rawKey,
    "From: a@example.com\r\nSubject: Recovered\r\n\r\nHello",
  );
  const retry = await request("/admin/inbound/retry", writer, { ids: [t.id] });
  expect((await retry.json()).retried).toEqual([t.id]);
  await stub.processIncoming();
  await stub.enqueueIncoming(t);
  const result = await request("/jmap", writer, {
    using: [CORE, MAIL],
    methodCalls: [
      [
        "Email/query",
        {
          accountId: "personal",
          filter: { subject: "Recovered" },
          calculateTotal: true,
        },
        "q",
      ],
    ],
  });
  expect((await result.json()).methodResponses[0][1].total).toBe(1);
});

test("workerd storage preview retains bytes, while apply deletes only an expired unreferenced blob", async () => {
  const upload = await request("/jmap/upload/personal", writer, {
    orphan: true,
  });
  const { blobId } = await upload.json();
  await storage.exec(
    "UPDATE blobs SET created_at=? WHERE id=?",
    Date.now() - 40 * 86400000,
    blobId,
  );
  const preview = await request("/admin/storage", writer, {});
  expect((await preview.json()).candidates.map((b) => b.id)).toContain(blobId);
  expect(await bucket.get(`blobs/${blobId}`)).not.toBeNull();
  const apply = await request("/admin/storage", writer, { apply: true });
  expect((await apply.json()).deleted).toBe(1);
  expect(await bucket.get(`blobs/${blobId}`)).toBeNull();
});

test("blob collection defers during active operations and serializes reuploads against deletion", async () => {
  await stub.beginOperation();
  expect(await stub.collectStorage(true)).toMatchObject({
    applied: false,
    deferred: "mailboxBusy",
  });
  await stub.endOperation();
  const bytes = new Uint8Array([9, 8, 7]);
  const { blobId } = await stub.upload(bytes, "application/octet-stream");
  await storage.exec("UPDATE blobs SET created_at=0 WHERE id=?", blobId);
  const result = await stub.collectAndReupload(
    bytes,
    "application/octet-stream",
  );
  expect(result).toEqual({ activeDuringCollection: 0, deleted: 1, blobId });
  expect(
    new Uint8Array(await (await bucket.get(`blobs/${blobId}`)).arrayBuffer()),
  ).toEqual(bytes);
});
