import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalProfileUrl, firstNameOf } from "../src/prospects";

test("canonicalProfileUrl reduces the many shapes of one profile to one string", () => {
  const canonical = "https://www.linkedin.com/in/jane-doe-1a2b3c";
  const variants = [
    "https://www.linkedin.com/in/jane-doe-1a2b3c",
    "https://www.linkedin.com/in/jane-doe-1a2b3c/",
    "https://linkedin.com/in/jane-doe-1a2b3c",
    "https://de.linkedin.com/in/jane-doe-1a2b3c",
    "https://www.linkedin.com/in/jane-doe-1a2b3c?miniProfileUrn=urn%3Ali%3A123",
    "https://www.linkedin.com/in/jane-doe-1a2b3c/overlay/about-this-profile/",
    "/in/jane-doe-1a2b3c/",
    "  https://www.linkedin.com/in/Jane-Doe-1A2B3C  ",
  ];
  for (const v of variants) {
    assert.equal(canonicalProfileUrl(v), canonical, `failed for ${v}`);
  }
});

test("canonicalProfileUrl rejects anything that is not a profile", () => {
  const rejected = [
    "",
    "not a url",
    "https://example.com/in/jane-doe",
    "https://www.linkedin.com/company/supersonic",
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/in/",
    // A lookalike domain must not pass the hostname check.
    "https://linkedin.com.evil.test/in/jane-doe",
  ];
  for (const v of rejected) {
    assert.equal(canonicalProfileUrl(v), null, `should reject ${v}`);
  }
});

test("firstNameOf strips the noise LinkedIn display names carry", () => {
  assert.equal(firstNameOf("Jane Doe"), "Jane");
  assert.equal(firstNameOf("Jane Doe, PhD"), "Jane");
  assert.equal(firstNameOf("Dr. Jane Doe"), "Jane");
  assert.equal(firstNameOf("Jane Doe 🚀"), "Jane");
  assert.equal(firstNameOf("Jane"), "Jane");
  assert.equal(firstNameOf(undefined), null);
  assert.equal(firstNameOf("   "), null);
});

test("firstNameOf keeps an honorific when it is the only word", () => {
  // Better to send a name that reads oddly than to send an empty greeting.
  assert.equal(firstNameOf("Dr."), "Dr.");
});
