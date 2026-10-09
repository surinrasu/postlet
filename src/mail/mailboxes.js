import { ROLES } from "../config.js";
import { assert, errorJSON } from "../errors.js";
import { finishSet, setArguments, setResponse } from "../jmap/set-result.js";
import {
  applyPatch,
  encoder,
  isObject,
  newId,
  resolveId,
  validId,
} from "../util.js";

export const RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};
export function mailboxSet(service, args, createdIds) {
  setArguments(args);
  service.store.assertState("Mailbox", args.ifInState);
  const response = setResponse(
    service.accountId,
    service.store.state("Mailbox"),
  );
  const validate = (mailbox, id) => {
    assert(
      typeof mailbox.name === "string" &&
        mailbox.name.trim().length > 0 &&
        encoder.encode(mailbox.name).length <= 255 &&
        !/[\x00-\x1f]/.test(mailbox.name),
      "invalidProperties",
      "Invalid mailbox name.",
      { properties: ["name"] },
    );
    assert(
      mailbox.role == null || ROLES.includes(mailbox.role),
      "invalidProperties",
      "Unknown role.",
    );
    assert(
      Number.isInteger(mailbox.sortOrder) &&
        mailbox.sortOrder >= 0 &&
        mailbox.sortOrder < 2147483648,
      "invalidProperties",
    );
    assert(typeof mailbox.isSubscribed === "boolean", "invalidProperties");
    mailbox.parentId = mailbox.parentId
      ? resolveId(mailbox.parentId, createdIds)
      : null;
    if (mailbox.parentId)
      assert(
        service.store.get("Mailbox", mailbox.parentId),
        "invalidProperties",
        "Unknown parent mailbox.",
      );
    const visited = new Set([id]);
    for (
      let parent = mailbox.parentId;
      parent;
      parent = service.store.get("Mailbox", parent)?.parentId
    ) {
      assert(
        !visited.has(parent),
        "invalidProperties",
        "Mailbox hierarchy contains a cycle.",
      );
      visited.add(parent);
    }
    for (const other of service.store.all("Mailbox"))
      if (other.id !== id) {
        assert(
          !(mailbox.role && other.role === mailbox.role),
          "invalidProperties",
          "Mailbox role already exists.",
        );
        assert(
          !(other.parentId === mailbox.parentId && other.name === mailbox.name),
          "invalidProperties",
          "A sibling mailbox has this name.",
        );
      }
    return mailbox;
  };
  service.store.transaction(() =>
    service.withRefreshBatch(() => {
      for (const [key, value] of Object.entries(args.create || {})) {
        try {
          assert(validId(key) && isObject(value));
          assert(
            Object.keys(value).every((property) =>
              [
                "name",
                "parentId",
                "role",
                "sortOrder",
                "isSubscribed",
              ].includes(property),
            ),
            "invalidProperties",
          );
          const id = newId("m");
          const mailbox = validate(
            {
              id,
              name: value.name,
              parentId: value.parentId ?? null,
              role: value.role ?? null,
              sortOrder: value.sortOrder ?? 0,
              totalEmails: 0,
              unreadEmails: 0,
              totalThreads: 0,
              unreadThreads: 0,
              myRights: RIGHTS,
              isSubscribed: value.isSubscribed ?? true,
            },
            id,
          );
          service.store.put("Mailbox", mailbox);
          response.created[key] = { id };
          createdIds[key] = id;
        } catch (error) {
          response.notCreated[key] = errorJSON(error, "mail_mutation");
        }
      }
      for (const [reference, patch] of Object.entries(args.update || {})) {
        let id = reference;
        try {
          id = resolveId(reference, createdIds);
          const old = service.store.get("Mailbox", id);
          assert(old, "notFound");
          assert(
            Object.keys(patch).every((key) =>
              ["name", "parentId", "sortOrder", "isSubscribed"].includes(key),
            ),
            "invalidProperties",
            "Mailbox roles are immutable.",
          );
          const next = {
            ...applyPatch(old, patch),
            parentId: Object.hasOwn(patch, "parentId")
              ? patch.parentId
              : old.parentId,
          };
          service.store.put("Mailbox", validate(next, id));
          response.updated[id] = null;
        } catch (error) {
          response.notUpdated[id] = errorJSON(error, "mail_mutation");
        }
      }
      for (const reference of args.destroy || []) {
        let id = reference;
        try {
          id = resolveId(reference, createdIds);
          service.store.transaction(() => {
            const old = service.store.get("Mailbox", id);
            assert(old, "notFound");
            assert(
              !old.role,
              "forbidden",
              "System mailboxes cannot be deleted.",
            );
            assert(
              !service.store.all("Mailbox").some((m) => m.parentId === id),
              "mailboxHasChild",
            );
            const emails = service.store
              .all("Email")
              .filter((e) => e.mailboxIds[id]);
            assert(
              args.onDestroyRemoveEmails || emails.length === 0,
              "mailboxHasEmail",
            );
            for (const email of emails) {
              if (Object.keys(email.mailboxIds).length === 1)
                service.destroyEmail(email.id);
              else
                service.updateEmail(email.id, { [`mailboxIds/${id}`]: null });
            }
            service.store.destroy("Mailbox", id);
          });
          response.destroyed.push(id);
        } catch (error) {
          response.notDestroyed[id] = errorJSON(error, "mail_mutation");
        }
      }
    }),
  );
  return finishSet(response, service.store.state("Mailbox"));
}
