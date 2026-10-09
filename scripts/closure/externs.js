// biome-ignore-all lint: Closure externs declare runtime APIs without implementations.
/**
 * @fileoverview Runtime APIs used by the Closure-checked modules.
 * @externs
 */

/** @template T */
class PostletAsyncLocalStorage {
  /** @return {(T|undefined)} */
  getStore() {}

  /** @template R @param {T} store @param {function(): R} callback @return {R} */
  run(store, callback) {}
}

/** @interface @extends {Iterable<?>} */
class PostletSqlCursor {
  /** @return {!Array<?>} */
  toArray() {}
  /** @return {?} */
  one() {}
  /** @return {!Iterator<?>} */
  [Symbol.iterator]() {}
}

/** @record */
class PostletSqlStorage {
  /** @param {string} query @param {...*} bindings @return {!PostletSqlCursor} */
  exec(query, ...bindings) {}
}
