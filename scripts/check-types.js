import { spawnSync } from "node:child_process";

const sources = [
  "src/contracts.js",
  "src/config.js",
  "src/store.js",
  "src/storage/migrations.js",
  "src/storage/processing.js",
  "src/jmap/set-result.js",
  "src/errors.js",
  "src/util.js",
  "src/diff.js",
  "src/observability.js",
  "src/auth-i18n.js",
  "src/auth-storage.js",
];

const result = spawnSync(
  "google-closure-compiler",
  [
    "--checks_only",
    "--warning_level",
    "VERBOSE",
    "--jscomp_error",
    "checkTypes",
    "--language_in",
    "ECMASCRIPT_NEXT",
    "--language_out",
    "ECMASCRIPT_NEXT",
    "--module_resolution",
    "BROWSER_WITH_TRANSFORMED_PREFIXES",
    "--browser_resolver_prefix_replacements",
    "node:async_hooks=scripts/closure/async-hooks.js",
    "--externs",
    "scripts/closure/externs.js",
    "--js",
    "scripts/closure/async-hooks.js",
    ...sources.flatMap((source) => ["--js", source]),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
