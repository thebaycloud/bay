import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicEmailProvider, domainOf } from "../lib/workspace";

test("domainOf lowercases and takes the part after @", () => {
  assert.equal(domainOf("Boris@Acme.COM"), "acme.com");
});

test("company domains are not public providers", () => {
  assert.equal(isPublicEmailProvider("acme.com"), false);
  assert.equal(isPublicEmailProvider("supersonic.cv"), false);
});

test("consumer providers are public", () => {
  for (const d of ["gmail.com", "yandex.ru", "mail.ru", "outlook.com", "icloud.com", "proton.me"]) {
    assert.equal(isPublicEmailProvider(d), true, `${d} should be public`);
  }
});

test("public provider matching is case-insensitive", () => {
  assert.equal(isPublicEmailProvider("GMAIL.COM"), true);
});
