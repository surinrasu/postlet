import { expect, test } from "bun:test";
import {
  authErrors,
  errorMessage,
  language,
  messages,
} from "../../src/auth-i18n.js";

test("language negotiation supports Chinese scripts and regions, weights and explicit preferences", () => {
  for (const [header, expected] of [
    ["en-GB", "en"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["zh-Hant-HK", "zh-Hant"],
    ["fr;q=1, zh-Hans;q=.8, en;q=.5", "zh-Hans"],
    ["zh;q=0,en;q=.5", "en"],
    ["ja", "en"],
  ]) {
    expect(
      language(
        new Request("https://mail.example/auth", {
          headers: { "Accept-Language": header },
        }),
      ),
    ).toBe(expected);
  }
  expect(
    language(
      new Request("https://mail.example/auth?lang=zh-Hant", {
        headers: { Cookie: "postlet-language=en", "Accept-Language": "zh-CN" },
      }),
    ),
  ).toBe("zh-Hant");
  expect(
    language(
      new Request("https://mail.example/auth?lang=invalid", {
        headers: { Cookie: "postlet-language=zh-Hans" },
      }),
    ),
  ).toBe("zh-Hans");
});

test("every supported language has the same complete UI vocabulary and localized errors", () => {
  const english = messages("en");
  for (const locale of ["en", "zh-Hans", "zh-Hant"]) {
    const translated = messages(locale);
    expect(Object.keys(translated)).toEqual(Object.keys(english));
    expect(
      Object.values(translated).every(
        (value) => typeof value === "string" && value.length > 0,
      ),
    ).toBe(true);
    const request = new Request(`https://mail.example/auth?lang=${locale}`);
    for (const [code, values] of Object.entries(authErrors)) {
      expect(code).toMatch(/^[a-z][a-zA-Z]+$/);
      expect(values).toHaveLength(3);
      expect(
        values.every((value) => typeof value === "string" && value.length > 0),
      ).toBe(true);
      expect(errorMessage(code, request)).not.toBe(translated.failed);
    }
    expect(errorMessage("unknownError", request)).toBe(translated.failed);
  }
});

test("English error identifiers resolve to the requested language", () => {
  for (const [locale, expected] of [
    ["en", "Invalid recovery code."],
    ["zh-Hans", "恢复码无效。"],
    ["zh-Hant", "復原碼無效。"],
  ]) {
    expect(
      errorMessage(
        "invalidRecoveryCode",
        new Request(`https://mail.example/auth?lang=${locale}`),
      ),
    ).toBe(expected);
  }
});
