import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, dedupeDoubledName, nameFromAriaLabel } from "../src/content/people";

// These are the DOM-free halves of the extraction. The DOM walk itself can only
// be verified against live LinkedIn markup — see README, "Verifying selectors".

test("cleanText collapses the whitespace LinkedIn markup is full of", () => {
  assert.equal(cleanText("  Jane   Doe \n "), "Jane Doe");
  assert.equal(cleanText("Jane Doe"), "Jane Doe");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
});

test("nameFromAriaLabel unwraps the profile-link phrasings", () => {
  assert.equal(nameFromAriaLabel("View Jane Doe's profile"), "Jane Doe");
  assert.equal(nameFromAriaLabel("Jane Doe's profile"), "Jane Doe");
  assert.equal(nameFromAriaLabel("View Jane Doe"), "Jane Doe");
  assert.equal(nameFromAriaLabel("Jane Doe"), "Jane Doe");
  assert.equal(nameFromAriaLabel(""), null);
  assert.equal(nameFromAriaLabel(null), null);
});

test("dedupeDoubledName collapses the a11y duplicate LinkedIn renders", () => {
  // The anchor contains a visible span and a visually-hidden copy, so raw
  // textContent reads the name twice.
  assert.equal(dedupeDoubledName("Jane DoeJane Doe"), "Jane Doe");
  assert.equal(dedupeDoubledName("Jane Doe"), "Jane Doe");
  // Odd length cannot be a clean doubling.
  assert.equal(dedupeDoubledName("Bob"), "Bob");
});

test("dedupeDoubledName leaves a genuine even-length name alone", () => {
  // "Anna" is even-length but "An" !== "na", so it must survive intact.
  assert.equal(dedupeDoubledName("Anna"), "Anna");
  assert.equal(dedupeDoubledName("Jo Li"), "Jo Li");
});
