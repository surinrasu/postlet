import { afterEach, expect, test } from "bun:test";
import { readDeployment } from "../../scripts/deployment.js";
import { serviceUrl } from "../../scripts/settings.js";

const original = {
  POSTLET_URL: process.env.POSTLET_URL,
  POSTLET_CONFIG: process.env.POSTLET_CONFIG,
};
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("operator scripts require an explicit service origin", () => {
  delete process.env.POSTLET_URL;
  expect(() => serviceUrl()).toThrow("Set POSTLET_URL");
  expect(serviceUrl("https://mail.example.com/")).toBe(
    "https://mail.example.com",
  );
  expect(serviceUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  for (const url of [
    "http://mail.example.com",
    "https://user:password@mail.example.com",
    "https://mail.example.com/jmap",
    "https://mail.example.com/?token=example",
    "https://mail.example.com/#example",
  ])
    expect(() => serviceUrl(url)).toThrow();
});

test("deployment operations reject an implicit target and public templates", async () => {
  delete process.env.POSTLET_CONFIG;
  await expect(readDeployment()).rejects.toThrow("Set POSTLET_CONFIG");
  for (const path of ["wrangler.jsonc", "wrangler.production.example.jsonc"]) {
    process.env.POSTLET_CONFIG = path;
    await expect(readDeployment()).rejects.toThrow(
      "Configure a real account_id",
    );
  }
});
