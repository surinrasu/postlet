import { CORE, MAIL, SUBMISSION } from "./config.js";
import * as model from "./contracts.js";
import { assert, errorJSON } from "./errors.js";
import { query, queryChanges } from "./query.js";
import { isObject, own, resolveId, resolvePointer } from "./util.js";

export function validateRequest(input) {
  assert(
    isObject(input) &&
      Array.isArray(input.using) &&
      input.using.every((s) => typeof s === "string") &&
      Array.isArray(input.methodCalls),
    "notRequest",
  );
  assert(
    input.using.every((capability) =>
      [CORE, MAIL, SUBMISSION].includes(capability),
    ),
    "unknownCapability",
  );
  assert(input.methodCalls.length <= 32, "limit", "Too many method calls.", {
    limit: "maxCallsInRequest",
  });
  assert(
    input.methodCalls.every(
      (call) =>
        Array.isArray(call) &&
        call.length === 3 &&
        typeof call[0] === "string" &&
        isObject(call[1]) &&
        typeof call[2] === "string",
    ),
    "notRequest",
  );
  assert(
    input.createdIds == null ||
      (isObject(input.createdIds) &&
        Object.values(input.createdIds).every((id) => typeof id === "string")),
  );
}

/** @param {*} service @param {*} outbox @param {!Object<string, *>} input @param {!model.AuthContext} auth */
export async function dispatch(service, outbox, input, auth) {
  validateRequest(input);
  const createdIds = Object.assign(Object.create(null), input.createdIds || {});
  const responses = [];
  for (const [name, original, tag] of input.methodCalls) {
    try {
      assert(auth.scopes.includes("read"), "forbidden");
      const args = { ...original };
      for (const property of Object.keys(args))
        if (property.startsWith("#")) {
          const reference = args[property];
          assert(
            isObject(reference) && !own(args, property.slice(1)),
            "invalidResultReference",
          );
          const response = responses.findLast(
            (r) => r[2] === reference.resultOf && r[0] === reference.name,
          );
          assert(response, "invalidResultReference");
          args[property.slice(1)] = resolvePointer(response[1], reference.path);
          delete args[property];
        }
      if (name === "Core/echo") {
        assert(input.using.includes(CORE), "unknownMethod");
        responses.push([name, args, tag]);
        continue;
      }
      const [type, method] = name.split("/");
      const capability =
        type === "Blob"
          ? CORE
          : ["Identity", "EmailSubmission"].includes(type)
            ? SUBMISSION
            : MAIL;
      assert(input.using.includes(capability), "unknownMethod");
      assert(args.accountId === service.accountId, "accountNotFound");
      if (["set", "import", "copy"].includes(method))
        assert(auth.scopes.includes("write"), "forbidden");
      if (type === "EmailSubmission" && method === "set")
        assert(auth.scopes.includes("send"), "forbidden");
      for (const key of [
        "ids",
        "blobIds",
        "properties",
        "bodyProperties",
        "onSuccessDestroyEmail",
      ]) {
        assert(
          args[key] == null ||
            (Array.isArray(args[key]) &&
              args[key].every((value) => typeof value === "string")),
          "invalidArguments",
          `${key} must be a string array.`,
        );
      }
      for (const key of [
        "fetchTextBodyValues",
        "fetchHTMLBodyValues",
        "fetchAllBodyValues",
        "collapseThreads",
        "calculateTotal",
        "filterAsTree",
        "sortAsTree",
        "onDestroyRemoveEmails",
      ])
        assert(args[key] == null || typeof args[key] === "boolean");
      assert(
        args.onSuccessUpdateEmail == null ||
          (isObject(args.onSuccessUpdateEmail) &&
            Object.values(args.onSuccessUpdateEmail).every(isObject)),
      );
      if (args.ids) args.ids = args.ids.map((id) => resolveId(id, createdIds));
      let result;
      if (
        ["Mailbox", "Email", "Thread", "Identity", "EmailSubmission"].includes(
          type,
        ) &&
        method === "get"
      )
        result = await service.get(type, args, auth);
      else if (
        ["Mailbox", "Email", "Thread", "Identity", "EmailSubmission"].includes(
          type,
        ) &&
        method === "changes"
      )
        result = {
          accountId: service.accountId,
          ...service.store.changes(
            type,
            args.sinceState,
            args.maxChanges ?? 256,
          ),
        };
      else if (
        ["Mailbox", "Email", "EmailSubmission"].includes(type) &&
        method === "query"
      )
        result = {
          accountId: service.accountId,
          ...(await query(service.store, type, args)).result,
        };
      else if (
        ["Mailbox", "Email", "EmailSubmission"].includes(type) &&
        method === "queryChanges"
      )
        result = {
          accountId: service.accountId,
          ...(await queryChanges(service.store, type, args)),
        };
      else if (name === "Mailbox/set")
        result = service.mailboxSet(args, createdIds);
      else if (name === "Email/set")
        result = await service.emailSet(args, createdIds);
      else if (name === "Email/import")
        result = await service.importEmails(args, createdIds);
      else if (name === "Email/parse") result = await service.parseEmails(args);
      else if (name === "Identity/set")
        result = service.identitySet(args, createdIds);
      else if (name === "EmailSubmission/set")
        result = outbox.set(args, createdIds);
      else if (name === "Email/copy") {
        assert(args.fromAccountId === service.accountId, "fromAccountNotFound");
        // There is exactly one account. JMAP forbids copying into the same account.
        assert(
          false,
          "invalidArguments",
          "Source and destination accounts must differ.",
        );
      } else if (name === "Blob/copy") {
        assert(args.fromAccountId === service.accountId, "fromAccountNotFound");
        assert(Array.isArray(args.blobIds));
        const copied = {},
          notCopied = {};
        for (const id of args.blobIds) {
          if (service.store.blob(id)) copied[id] = id;
          else notCopied[id] = { type: "blobNotFound" };
        }
        result = {
          fromAccountId: service.accountId,
          accountId: service.accountId,
          copied,
          notCopied,
        };
      } else assert(false, "unknownMethod");
      responses.push([name, result, tag]);
      if (
        name === "EmailSubmission/set" &&
        (args.onSuccessUpdateEmail || args.onSuccessDestroyEmail)
      ) {
        const update = {},
          destroy = [];
        const successful = (ref) =>
          ref.startsWith("#")
            ? Boolean(result.created?.[ref.slice(1)])
            : own(result.updated || {}, ref) ||
              (result.destroyed || []).includes(ref);
        for (const [reference, patch] of Object.entries(
          args.onSuccessUpdateEmail || {},
        )) {
          if (!successful(reference)) continue;
          const submission = service.store.get(
            "EmailSubmission",
            resolveId(reference, createdIds),
          );
          if (submission) update[submission.emailId] = patch;
        }
        for (const reference of args.onSuccessDestroyEmail || []) {
          if (!successful(reference)) continue;
          const submission = service.store.get(
            "EmailSubmission",
            resolveId(reference, createdIds),
          );
          if (submission) destroy.push(submission.emailId);
        }
        if (Object.keys(update).length || destroy.length)
          responses.push([
            "Email/set",
            await service.emailSet({ update, destroy }, createdIds),
            tag,
          ]);
      }
    } catch (error) {
      responses.push(["error", errorJSON(error, "jmap_dispatch"), tag]);
    }
  }
  return {
    methodResponses: responses,
    sessionState: `postlet-1-${auth.scopes.includes("write") ? "w" : "r"}-${auth.scopes.includes("send") && service.env.SEND_ENABLED === "true" ? "s" : "n"}`,
    ...(input.createdIds != null ? { createdIds } : {}),
  };
}
