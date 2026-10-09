import { assert, errorJSON } from "../errors.js";
import { finishSet, setArguments, setResponse } from "../jmap/set-result.js";
import { validateAddresses } from "../mime.js";
import { applyPatch, encoder, newId, validAddress } from "../util.js";

export function identitySet(service, args, createdIds) {
  setArguments(args);
  service.store.assertState("Identity", args.ifInState);
  const response = setResponse(
    service.accountId,
    service.store.state("Identity"),
  );
  const validate = (identity) => {
    assert(
      validAddress(identity.email) &&
        identity.email
          .toLowerCase()
          .endsWith(`@${service.env.MAIL_DOMAIN.toLowerCase()}`),
      "invalidProperties",
      "Identity must belong to the configured mail domain.",
    );
    assert(
      typeof identity.name === "string" && !/[\r\n]/.test(identity.name),
      "invalidProperties",
    );
    assert(
      typeof identity.textSignature === "string" &&
        typeof identity.htmlSignature === "string",
      "invalidProperties",
    );
    if (identity.replyTo !== null) validateAddresses(identity.replyTo);
    if (identity.bcc !== null) validateAddresses(identity.bcc);
    assert(
      encoder.encode(JSON.stringify(identity)).length < 16384,
      "invalidProperties",
    );
    return identity;
  };
  service.store.transaction(() => {
    for (const [key, input] of Object.entries(args.create || {})) {
      try {
        assert(
          Object.keys(input).every((k) =>
            [
              "name",
              "email",
              "replyTo",
              "bcc",
              "textSignature",
              "htmlSignature",
            ].includes(k),
          ),
          "invalidProperties",
        );
        const identity = validate({
          id: newId("i"),
          name: "",
          replyTo: null,
          bcc: null,
          textSignature: "",
          htmlSignature: "",
          ...input,
          mayDelete: true,
        });
        service.store.put("Identity", identity);
        response.created[key] = { id: identity.id };
        createdIds[key] = identity.id;
      } catch (error) {
        response.notCreated[key] = errorJSON(error, "mail_mutation");
      }
    }
    for (const [id, patch] of Object.entries(args.update || {})) {
      try {
        const old = service.store.get("Identity", id);
        assert(old, "notFound");
        assert(
          Object.keys(patch).every((key) =>
            [
              "name",
              "replyTo",
              "bcc",
              "textSignature",
              "htmlSignature",
            ].includes(key),
          ),
          "invalidProperties",
        );
        const next = applyPatch(old, patch);
        next.replyTo ??= null;
        next.bcc ??= null;
        service.store.put("Identity", validate(next));
        response.updated[id] = null;
      } catch (error) {
        response.notUpdated[id] = errorJSON(error, "mail_mutation");
      }
    }
    for (const id of args.destroy || []) {
      try {
        const old = service.store.get("Identity", id);
        assert(old, "notFound");
        assert(old.mayDelete, "forbidden");
        service.store.destroy("Identity", id);
        response.destroyed.push(id);
      } catch (error) {
        response.notDestroyed[id] = errorJSON(error, "mail_mutation");
      }
    }
  });
  return finishSet(response, service.store.state("Identity"));
}
