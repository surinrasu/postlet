import { MAX_OBJECTS, maxMessageBytes, ROLES } from "./config.js";
import * as model from "./contracts.js";
import { assert, errorJSON, JmapError } from "./errors.js";
import { finishSet, setArguments, setResponse } from "./jmap/set-result.js";
import { emailView } from "./mail/email-view.js";
import { identitySet } from "./mail/identities.js";
import { mailboxSet, RIGHTS } from "./mail/mailboxes.js";
import { blobId, composeMessage, parseMessage } from "./mime.js";
import {
  applyPatch,
  encoder,
  isObject,
  isoDate,
  newId,
  resolveId,
  selectProperties,
  validId,
} from "./util.js";

export function checkKeywords(keywords = {}) {
  assert(
    isObject(keywords) && Object.keys(keywords).length <= 128,
    "invalidProperties",
    "Invalid keywords.",
    { properties: ["keywords"] },
  );
  for (const [key, value] of Object.entries(keywords))
    assert(
      value === true && /^[^\x00-\x20(){}%*"\\[\]]{1,255}$/.test(key),
      "invalidProperties",
      "Invalid keyword.",
      { properties: ["keywords"] },
    );
  return keywords;
}

export class MailService {
  constructor(store, env) {
    this.store = store;
    this.env = env;
    this.accountId = env.ACCOUNT_ID || "personal";
  }

  initialize() {
    if (this.store.get("Mailbox", "m_inbox")) return;
    this.store.transaction(() => {
      for (const [sortOrder, role] of ROLES.entries())
        this.store.put("Mailbox", {
          id: `m_${role}`,
          name: role[0].toUpperCase() + role.slice(1),
          parentId: null,
          role,
          sortOrder,
          totalEmails: 0,
          unreadEmails: 0,
          totalThreads: 0,
          unreadThreads: 0,
          myRights: RIGHTS,
          isSubscribed: true,
        });
      this.store.put("Identity", {
        id: "i_default",
        name: this.env.MAIL_NAME || "",
        email: this.env.MAIL_ADDRESS,
        replyTo: null,
        bcc: null,
        textSignature: "",
        htmlSignature: "",
        mayDelete: false,
      });
    });
  }

  async putBlob(bytes, type = "application/octet-stream") {
    const id = await blobId(bytes);
    await this.env.MAIL.put(`blobs/${id}`, bytes, {
      httpMetadata: { contentType: type },
    });
    this.store.registerBlob(id, bytes.byteLength, type);
    return id;
  }

  async getBlob(id) {
    if (!validId(id) || !this.store.blob(id)) return null;
    return this.env.MAIL.get(`blobs/${id}`);
  }

  checkMailboxes(mailboxIds, createdIds = {}) {
    assert(
      isObject(mailboxIds) &&
        Object.keys(mailboxIds).length > 0 &&
        Object.keys(mailboxIds).length <= 128,
      "invalidProperties",
      "An email must belong to at least one mailbox.",
      { properties: ["mailboxIds"] },
    );
    const result = {};
    for (const [reference, value] of Object.entries(mailboxIds)) {
      const id = resolveId(reference, createdIds);
      assert(
        value === true && this.store.get("Mailbox", id),
        "invalidProperties",
        "Unknown mailbox.",
        { properties: ["mailboxIds"] },
      );
      result[id] = true;
    }
    return result;
  }

  withRefreshBatch(callback) {
    if (this.refreshPending) return callback();
    const pending = { mailboxes: new Set(), threads: new Set() };
    this.refreshPending = pending;
    let result;
    try {
      result = callback();
    } finally {
      this.refreshPending = null;
    }
    this.refresh([...pending.mailboxes], [...pending.threads]);
    return result;
  }

  refresh(mailboxIds, threadIds) {
    if (this.refreshPending) {
      for (const id of mailboxIds) this.refreshPending.mailboxes.add(id);
      for (const id of threadIds) this.refreshPending.threads.add(id);
      return;
    }
    for (const threadId of new Set(threadIds)) {
      const members = this.store.sql
        .exec(
          "SELECT id,received_at FROM email_index WHERE thread_id=? ORDER BY received_at,id",
          threadId,
        )
        .toArray();
      if (members.length)
        this.store.put("Thread", {
          id: threadId,
          emailIds: members.map((email) => email.id),
        });
      else this.store.destroy("Thread", threadId);
    }
    for (const id of new Set(mailboxIds)) {
      const mailbox = this.store.get("Mailbox", id);
      if (!mailbox) continue;
      const counts = this.store.sql
        .exec(
          "SELECT count(*) AS totalEmails,coalesce(sum(1-e.seen),0) AS unreadEmails,count(DISTINCT e.thread_id) AS totalThreads,count(DISTINCT CASE WHEN e.seen=0 THEN e.thread_id END) AS unreadThreads FROM email_mailboxes m JOIN email_index e ON e.id=m.email_id WHERE m.mailbox_id=?",
          id,
        )
        .one();
      this.store.put("Mailbox", { ...mailbox, ...counts });
    }
  }

  findThread(data) {
    const references = [
      ...(data.inReplyTo || []),
      ...(data.references || []).toReversed(),
      ...(data.messageId || []),
    ];
    for (const ref of references.slice(0, 100)) {
      const rows = this.store.sql
        .exec(
          "SELECT json_extract(o.data,'$.threadId') AS thread_id FROM objects o, json_each(o.data,'$.messageId') m WHERE o.type='Email' AND m.value=? LIMIT 1",
          ref,
        )
        .toArray();
      if (rows.length) return rows[0].thread_id;
    }
    return newId("t");
  }

  /** @param {!Uint8Array} raw @param {!Object<string, *>=} properties @return {!Promise<!model.PreparedEmail>} */
  async prepareEmail(raw, properties = {}) {
    assert(raw.byteLength <= maxMessageBytes(this.env), "tooLarge");
    const rawId = await this.putBlob(raw, "message/rfc822");
    const parsed = await parseMessage(raw, (bytes, type) =>
      this.putBlob(bytes, type),
    );
    const bodiesId = await this.putBlob(
      encoder.encode(JSON.stringify(parsed.bodies)),
      "application/json",
    );
    const email = {
      ...parsed.data,
      id: newId("e"),
      blobId: rawId,
      size: raw.byteLength,
      receivedAt: properties.receivedAt
        ? isoDate(properties.receivedAt)
        : new Date().toISOString(),
      mailboxIds: properties.mailboxIds,
      keywords: checkKeywords(properties.keywords || {}),
      _bodiesBlobId: bodiesId,
    };
    return { email, search: parsed.search };
  }

  /** @param {!model.PreparedEmail} prepared @param {!Object<string, string>=} createdIds */
  insertPrepared(prepared, createdIds = {}) {
    const email = prepared.email;
    email.mailboxIds = this.checkMailboxes(email.mailboxIds, createdIds);
    email.threadId = this.findThread(email);
    this.store.put("Email", email);
    this.store.indexEmail(email, prepared.search);
    this.refresh(Object.keys(email.mailboxIds), [email.threadId]);
    return {
      id: email.id,
      blobId: email.blobId,
      threadId: email.threadId,
      size: email.size,
    };
  }

  updateEmail(id, patch, createdIds = {}) {
    const old = this.store.get("Email", id);
    assert(old, "notFound");
    for (const property of Object.keys(patch))
      assert(
        ["mailboxIds", "keywords"].includes(property.split("/")[0]),
        "invalidProperties",
        "Only mailboxIds and keywords are mutable.",
        { properties: [property] },
      );
    const email = applyPatch(old, patch);
    email.mailboxIds = this.checkMailboxes(email.mailboxIds, createdIds);
    email.keywords = checkKeywords(email.keywords || {});
    this.store.put("Email", email);
    this.store.indexEmail(email);
    this.refresh(
      [...Object.keys(old.mailboxIds), ...Object.keys(email.mailboxIds)],
      [email.threadId],
    );
  }

  destroyEmail(id) {
    const old = this.store.get("Email", id);
    assert(old, "notFound");
    // Submissions hold their own immutable blob reference. Deleting an Email
    // must not cancel an already accepted submission.
    this.store.destroy("Email", id);
    this.store.sql.exec("DELETE FROM email_mailboxes WHERE email_id=?", id);
    this.store.sql.exec("DELETE FROM email_search WHERE email_id=?", id);
    this.refresh(Object.keys(old.mailboxIds), [old.threadId]);
  }

  /** @param {string} type @param {!Object<string, *>} args @param {!model.AuthContext} auth */
  async get(type, args, auth) {
    const ids = args.ids ?? this.store.all(type).map((object) => object.id);
    assert(Array.isArray(ids) && ids.every((id) => typeof id === "string"));
    assert(ids.length <= MAX_OBJECTS, "tooManyObjects");
    const state = this.store.state(type);
    // Snapshot before any blob I/O so state and metadata describe the same view.
    const objects = [...new Set(ids)].map((id) => [
      id,
      this.store.get(type, id),
    ]);
    const list = [],
      notFound = [];
    for (const [id, object] of objects) {
      if (!object) {
        notFound.push(id);
        continue;
      }
      if (type === "Email") list.push(await this.emailView(object, args));
      else {
        const projected = selectProperties(object, args.properties);
        for (const key of Object.keys(projected))
          if (key.startsWith("_")) delete projected[key];
        if (type === "Mailbox" && projected.myRights)
          projected.myRights = Object.fromEntries(
            Object.keys(RIGHTS).map((key) => [
              key,
              key === "mayReadItems" ||
                (key === "maySubmit"
                  ? auth.scopes.includes("send") &&
                    this.env.SEND_ENABLED === "true"
                  : auth.scopes.includes("write") &&
                    !(key === "mayDelete" && object.role)),
            ]),
          );
        list.push(projected);
      }
    }
    return { accountId: this.accountId, state, list, notFound };
  }

  async emailSet(args, createdIds) {
    setArguments(args);
    this.store.assertState("Email", args.ifInState);
    const response = setResponse(this.accountId, this.store.state("Email"));
    // Prepare R2 data first, then verify the conditional state once more and
    // commit the whole /set in a synchronous SQLite transaction.
    const prepared = Object.create(null);
    for (const [key, input] of Object.entries(args.create || {})) {
      try {
        assert(validId(key) && isObject(input));
        this.checkMailboxes(input.mailboxIds, createdIds);
        checkKeywords(input.keywords || {});
        const raw = await composeMessage(input, this.env, (id) =>
          this.getBlob(resolveId(id, createdIds)),
        );
        prepared[key] = await this.prepareEmail(raw, input);
      } catch (error) {
        response.notCreated[key] = errorJSON(error, "mail_mutation");
      }
    }
    this.store.transaction(() =>
      this.withRefreshBatch(() => {
        this.store.assertState("Email", args.ifInState);
        response.oldState = this.store.state("Email");
        for (const [key, value] of Object.entries(prepared)) {
          try {
            const object = this.store.transaction(() =>
              this.insertPrepared(value, createdIds),
            );
            response.created[key] = object;
            createdIds[key] = object.id;
          } catch (error) {
            response.notCreated[key] = errorJSON(error, "mail_mutation");
          }
        }
        for (const [reference, patch] of Object.entries(args.update || {})) {
          let id = reference;
          try {
            id = resolveId(reference, createdIds);
            this.store.transaction(() =>
              this.updateEmail(id, patch, createdIds),
            );
            response.updated[id] = null;
          } catch (error) {
            response.notUpdated[id] = errorJSON(error, "mail_mutation");
          }
        }
        for (const reference of args.destroy || []) {
          let id = reference;
          try {
            id = resolveId(reference, createdIds);
            this.store.transaction(() => this.destroyEmail(id));
            response.destroyed.push(id);
          } catch (error) {
            response.notDestroyed[id] = errorJSON(error, "mail_mutation");
          }
        }
      }),
    );
    return finishSet(response, this.store.state("Email"));
  }

  async importEmails(args, createdIds) {
    assert(
      isObject(args.emails) && Object.keys(args.emails).length <= MAX_OBJECTS,
    );
    this.store.assertState("Email", args.ifInState);
    let oldState;
    const created = Object.create(null),
      notCreated = Object.create(null),
      prepared = Object.create(null);
    for (const [key, input] of Object.entries(args.emails)) {
      try {
        this.checkMailboxes(input.mailboxIds, createdIds);
        const blob = await this.getBlob(resolveId(input.blobId, createdIds));
        assert(blob, "blobNotFound");
        prepared[key] = await this.prepareEmail(
          new Uint8Array(await blob.arrayBuffer()),
          input,
        );
      } catch (error) {
        notCreated[key] = errorJSON(error, "mail_mutation");
      }
    }
    this.store.transaction(() =>
      this.withRefreshBatch(() => {
        this.store.assertState("Email", args.ifInState);
        oldState = this.store.state("Email");
        for (const [key, preparedEmail] of Object.entries(prepared)) {
          try {
            created[key] = this.store.transaction(() =>
              this.insertPrepared(preparedEmail, createdIds),
            );
            createdIds[key] = created[key].id;
          } catch (error) {
            notCreated[key] = errorJSON(error, "mail_mutation");
          }
        }
      }),
    );
    return {
      accountId: this.accountId,
      oldState,
      newState: this.store.state("Email"),
      created: Object.keys(created).length ? created : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
    };
  }

  async parseEmails(args) {
    assert(Array.isArray(args.blobIds) && args.blobIds.length <= MAX_OBJECTS);
    const parsed = Object.create(null),
      notParsable = [],
      notFound = [];
    for (const id of args.blobIds) {
      const blob = await this.getBlob(id);
      if (!blob) {
        notFound.push(id);
        continue;
      }
      try {
        const prepared = await this.prepareEmail(
          new Uint8Array(await blob.arrayBuffer()),
          { mailboxIds: { m_inbox: true } },
        );
        parsed[id] = await this.emailView(prepared.email, args);
        for (const property of [
          "id",
          "threadId",
          "mailboxIds",
          "keywords",
          "receivedAt",
        ])
          delete parsed[id][property];
      } catch (error) {
        if (
          error instanceof JmapError &&
          ["invalidEmail", "tooLarge"].includes(error.type)
        )
          notParsable.push(id);
        else throw error;
      }
    }
    return {
      accountId: this.accountId,
      parsed: Object.keys(parsed).length ? parsed : null,
      notParsable: notParsable.length ? notParsable : null,
      notFound: notFound.length ? notFound : null,
    };
  }

  emailView(email, args) {
    return emailView(this, email, args);
  }

  mailboxSet(args, createdIds) {
    return mailboxSet(this, args, createdIds);
  }

  identitySet(args, createdIds) {
    return identitySet(this, args, createdIds);
  }
}
