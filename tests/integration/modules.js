import { readdirSync } from "node:fs";

export const workerModules = () => [
  { type: "ESModule", path: "dist/worker.js" },
  ...readdirSync("dist")
    .filter(
      (name) =>
        name.endsWith(".browser.js") ||
        name.endsWith(".umd.min.js") ||
        name.endsWith(".css"),
    )
    .map((name) => ({ type: "Text", path: `dist/${name}` })),
];
