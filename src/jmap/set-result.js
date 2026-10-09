import { MAX_OBJECTS } from "../config.js";
import * as model from "../contracts.js";
import { assert } from "../errors.js";
import { isObject } from "../util.js";

/** @param {!Object<string, *>} args */
export function setArguments(args) {
  for (const name of ["create", "update"])
    assert(args[name] == null || isObject(args[name]));
  assert(
    args.destroy == null ||
      (Array.isArray(args.destroy) &&
        args.destroy.every((id) => typeof id === "string")),
  );
  const count =
    Object.keys(args.create || {}).length +
    Object.keys(args.update || {}).length +
    (args.destroy || []).length;
  assert(count <= MAX_OBJECTS, "requestTooLarge");
}

/** @param {string} accountId @param {string} oldState @return {!model.SetResult} */
export function setResponse(accountId, oldState) {
  return {
    accountId,
    oldState,
    newState: oldState,
    created: Object.create(null),
    updated: Object.create(null),
    destroyed: [],
    notCreated: Object.create(null),
    notUpdated: Object.create(null),
    notDestroyed: Object.create(null),
  };
}

/** @param {!model.SetResult} result @param {string} state @return {!model.SetResult} */
export function finishSet(result, state) {
  result.newState = state;
  for (const key of [
    "created",
    "updated",
    "notCreated",
    "notUpdated",
    "notDestroyed",
  ])
    if (!Object.keys(result[key]).length) result[key] = null;
  if (!result.destroyed.length) result.destroyed = null;
  return result;
}
