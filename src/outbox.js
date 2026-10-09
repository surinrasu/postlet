import { EmailMessage } from "cloudflare:email";
import { MAX_SEND_BYTES } from "./config.js";
import * as model from "./contracts.js";
import { assert, errorJSON } from "./errors.js";
import { finishSet, setArguments, setResponse } from "./jmap/set-result.js";
import { withoutBcc } from "./mime.js";
import { logEvent } from "./observability.js";
import { isObject, newId, resolveId, validAddress } from "./util.js";

const REJECTED_CODES = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_CONTENT_TOO_LARGE",
  "E_INVALID_EMAIL",
  "E_RECIPIENT_SUPPRESSED",
  "E_INVALID_SENDER",
  "E_INVALID_RECIPIENT",
]);
const RETRY_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
]);

export class Outbox {
  constructor(store, env) {
    this.store = store;
    this.env = env;
    this.accountId = env.ACCOUNT_ID || "personal";
  }

  set(args, createdIds) {
    setArguments(args);
    assert(
      this.env.SEND_ENABLED === "true",
      "forbidden",
      "Outbound sending is not enabled.",
    );
    this.store.assertState("EmailSubmission", args.ifInState);
    const result = setResponse(
      this.accountId,
      this.store.state("EmailSubmission"),
    );
    this.store.transaction(() => {
      for (const [key, input] of Object.entries(args.create || {})) {
        try {
          assert(
            isObject(input) &&
              Object.keys(input).every((p) =>
                ["identityId", "emailId", "envelope"].includes(p),
              ),
            "invalidProperties",
          );
          const identity = this.store.get(
            "Identity",
            resolveId(input.identityId, createdIds),
          );
          assert(identity, "invalidProperties", "Unknown sending identity.", {
            properties: ["identityId"],
          });
          const email = this.store.get(
            "Email",
            resolveId(input.emailId, createdIds),
          );
          assert(email, "invalidProperties", "Unknown email.", {
            properties: ["emailId"],
          });
          assert(email.size <= MAX_SEND_BYTES, "tooLarge");
          assert(
            email.from?.length === 1 &&
              email.from[0].email.toLowerCase() ===
                identity.email.toLowerCase(),
            "forbiddenFrom",
            "The From address must match the selected identity.",
          );
          assert(
            !email.sender ||
              (email.sender.length === 1 &&
                email.sender[0].email.toLowerCase() ===
                  identity.email.toLowerCase()),
            "forbiddenFrom",
          );
          const envelope = input.envelope || {
            mailFrom: { email: identity.email, parameters: null },
            rcptTo: [
              ...(email.to || []),
              ...(email.cc || []),
              ...(email.bcc || []),
            ].map((a) => ({ email: a.email, parameters: null })),
          };
          assert(
            isObject(envelope.mailFrom) &&
              envelope.mailFrom.email.toLowerCase() ===
                identity.email.toLowerCase(),
            "forbiddenMailFrom",
          );
          assert(
            Array.isArray(envelope.rcptTo) && envelope.rcptTo.length > 0,
            "noRecipients",
          );
          assert(envelope.rcptTo.length <= 50, "tooManyRecipients");
          assert(
            envelope.rcptTo.every((r) => isObject(r) && validAddress(r.email)),
            "invalidRecipients",
          );
          assert(
            [envelope.mailFrom, ...envelope.rcptTo].every(
              (a) =>
                a.parameters == null ||
                (isObject(a.parameters) &&
                  Object.keys(a.parameters).length === 0),
            ),
            "invalidProperties",
            "SMTP envelope extensions are not supported.",
          );
          envelope.rcptTo = [
            ...new Map(
              envelope.rcptTo.map((r) => [
                r.email.toLowerCase(),
                { email: r.email, parameters: null },
              ]),
            ).values(),
          ];
          const id = newId("s"),
            sendAt = new Date().toISOString();
          /** @type {!model.Submission} */
          const submission = {
            id,
            identityId: identity.id,
            emailId: email.id,
            threadId: email.threadId,
            envelope,
            sendAt,
            undoStatus: "pending",
            deliveryStatus: null,
            dsnBlobIds: [],
            mdnBlobIds: [],
            _blobId: email.blobId,
            _recipients: {},
          };
          this.store.put("EmailSubmission", submission);
          this.store.sql.exec(
            "INSERT INTO outbox(id,status,due) VALUES(?,'ready',?)",
            id,
            Date.now(),
          );
          result.created[key] = { id, sendAt, undoStatus: "pending" };
          createdIds[key] = id;
        } catch (error) {
          result.notCreated[key] = errorJSON(error, "submission_mutation");
        }
      }
      for (const [reference, patch] of Object.entries(args.update || {})) {
        let id = reference;
        try {
          id = resolveId(reference, createdIds);
          const submission = this.store.get("EmailSubmission", id);
          assert(submission, "notFound");
          assert(
            Object.keys(patch).length === 1 && patch.undoStatus === "canceled",
            "invalidProperties",
          );
          const job = this.store.sql
            .exec("SELECT status FROM outbox WHERE id=?", id)
            .toArray()[0];
          assert(
            submission.undoStatus === "pending" && job?.status === "ready",
            "cannotUnsend",
          );
          this.store.put("EmailSubmission", {
            ...submission,
            undoStatus: "canceled",
          });
          this.store.sql.exec(
            "UPDATE outbox SET status='canceled' WHERE id=?",
            id,
          );
          result.updated[id] = null;
        } catch (error) {
          result.notUpdated[id] = errorJSON(error, "submission_mutation");
        }
      }
      for (const reference of args.destroy || []) {
        let id = reference;
        try {
          id = resolveId(reference, createdIds);
          const submission = this.store.get("EmailSubmission", id);
          assert(submission, "notFound");
          assert(
            submission.undoStatus !== "pending",
            "forbidden",
            "Cancel a pending submission before deleting its record.",
          );
          this.store.destroy("EmailSubmission", id);
          this.store.sql.exec("DELETE FROM outbox WHERE id=?", id);
          result.destroyed.push(id);
        } catch (error) {
          result.notDestroyed[id] = errorJSON(error, "submission_mutation");
        }
      }
    });
    return finishSet(result, this.store.state("EmailSubmission"));
  }

  /** Jobs with an interrupted network attempt are never automatically resent. */
  recover() {
    const jobs = this.store.sql
      .exec(
        "SELECT id FROM outbox WHERE status='sending' AND attempt_at<?",
        Date.now() - 5 * 60 * 1000,
      )
      .toArray();
    for (const { id } of jobs)
      this.store.transaction(() => {
        const s = this.store.get("EmailSubmission", id);
        if (s) this.store.put("EmailSubmission", { ...s, undoStatus: "final" });
        this.store.sql.exec(
          "UPDATE outbox SET status='unknown',error='Interrupted send; delivery may have occurred. Do not retry automatically.' WHERE id=?",
          id,
        );
      });
  }

  async process() {
    this.recover();
    if (this.env.SEND_ENABLED !== "true") return;
    const jobs = this.store.sql
      .exec(
        "SELECT id FROM outbox WHERE status='ready' AND due<=? ORDER BY due LIMIT 5",
        Date.now(),
      )
      .toArray();
    for (const { id } of jobs) {
      const claimed = this.store.transaction(() => {
        const current = this.store.sql
          .exec("SELECT status FROM outbox WHERE id=?", id)
          .toArray()[0];
        if (current?.status !== "ready") return false;
        this.store.sql.exec(
          "UPDATE outbox SET status='sending',attempt_at=? WHERE id=?",
          Date.now(),
          id,
        );
        return true;
      });
      if (!claimed) continue;
      // A watchdog survives a crash while awaiting the external provider.
      await this.store.storage.setAlarm(Date.now() + 6 * 60 * 1000);
      const submission = this.store.get("EmailSubmission", id);
      if (!submission) {
        this.store.sql.exec(
          "UPDATE outbox SET status='failed',error='Missing submission' WHERE id=?",
          id,
        );
        continue;
      }
      const rawObject = await this.env.MAIL.get(`blobs/${submission._blobId}`);
      if (!rawObject) {
        this.fail(id, "Missing raw message");
        continue;
      }
      let raw;
      try {
        raw = withoutBcc(new Uint8Array(await rawObject.arrayBuffer()));
      } catch {
        this.fail(id, "Invalid raw message");
        continue;
      }
      let hasUnknown = false,
        retry = false;
      for (const recipient of submission.envelope.rcptTo) {
        const email = recipient.email;
        const previous = submission._recipients[email];
        if (previous === "accepted" || previous === "rejected") continue;
        if (previous === "sending" || previous === "unknown") {
          hasUnknown = true;
          continue;
        }
        // Persist intent before starting the network call. Each envelope recipient
        // is delivered independently, so retries cannot duplicate accepted ones.
        submission._recipients[email] = "sending";
        submission.deliveryStatus ??= {};
        submission.deliveryStatus[email] = {
          smtpReply: "",
          delivered: "unknown",
          displayed: "unknown",
        };
        this.store.put("EmailSubmission", submission);
        try {
          const response = await this.env.OUTBOUND.send(
            new EmailMessage(
              submission.envelope.mailFrom.email,
              email,
              new Blob([raw]).stream(),
            ),
          );
          submission._recipients[email] = "accepted";
          submission.deliveryStatus[email] = {
            smtpReply: "250 2.0.0 Accepted by outbound provider",
            delivered: "unknown",
            displayed: "unknown",
          };
          submission._providerMessageId = response?.messageId || null;
        } catch (error) {
          logEvent(
            "outbound_attempt_failed",
            {
              submissionId: String(id),
              stage: "provider_send",
              retryable: RETRY_CODES.has(error.code),
            },
            error,
          );
          if (RETRY_CODES.has(error.code)) {
            delete submission._recipients[email];
            retry = true;
          } else if (REJECTED_CODES.has(error.code)) {
            submission._recipients[email] = "rejected";
            submission.deliveryStatus[email] = {
              smtpReply: "550 5.0.0 Rejected by outbound provider",
              delivered: "no",
              displayed: "unknown",
            };
          } else {
            submission._recipients[email] = "unknown";
            hasUnknown = true;
          }
        }
        this.store.put("EmailSubmission", submission);
      }
      this.store.transaction(() => {
        if (retry && !hasUnknown)
          this.store.sql.exec(
            "UPDATE outbox SET status='ready',due=? WHERE id=?",
            Date.now() + 15 * 60 * 1000,
            id,
          );
        else {
          submission.undoStatus = "final";
          this.store.put("EmailSubmission", submission);
          this.store.sql.exec(
            "UPDATE outbox SET status=?,error=? WHERE id=?",
            hasUnknown ? "unknown" : "complete",
            hasUnknown
              ? "Delivery may have occurred. Inspect before creating another submission."
              : null,
            id,
          );
        }
      });
    }
  }

  fail(id, reason) {
    this.store.transaction(() => {
      const s = this.store.get("EmailSubmission", id);
      if (s) {
        s.undoStatus = "final";
        s.deliveryStatus = Object.fromEntries(
          s.envelope.rcptTo.map((r) => [
            r.email,
            {
              smtpReply: "550 5.0.0 Local submission failure",
              delivered: "no",
              displayed: "unknown",
            },
          ]),
        );
        this.store.put("EmailSubmission", s);
      }
      this.store.sql.exec(
        "UPDATE outbox SET status='failed',error=? WHERE id=?",
        reason,
        id,
      );
    });
  }
}
