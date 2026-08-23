import test from "node:test";
import assert from "node:assert/strict";
import { recordFor } from "@/lib/dns-record";

const DNS = { ip: "8.233.7.157", cname: "l3sgp.thebay.cloud" };

test("an apex gets an A record at @, because a root cannot be a CNAME", () => {
  assert.deepEqual(recordFor("acme.com", DNS), {
    type: "A", name: "@", value: DNS.ip, guessed: false,
  });
  // A newer gTLD is still two labels.
  assert.deepEqual(recordFor("arsen.vodka", DNS).type, "A");
  assert.deepEqual(recordFor("arsen.vodka", DNS).name, "@");
});

test("a subdomain gets a CNAME, named by its label alone", () => {
  // `www`, not `www.acme.com`: nearly every DNS panel appends the zone itself,
  // so the full name typed there becomes www.acme.com.acme.com.
  assert.deepEqual(recordFor("www.acme.com", DNS), {
    type: "CNAME", name: "www", value: DNS.cname, guessed: false,
  });
  assert.deepEqual(recordFor("shop.eu.acme.com", DNS), {
    type: "CNAME", name: "shop.eu", value: DNS.cname, guessed: false,
  });
});

test("a two-level suffix is a root, not a subdomain of itself", () => {
  // The case label counting gets wrong: three labels, and still an apex.
  assert.deepEqual(recordFor("acme.co.uk", DNS), {
    type: "A", name: "@", value: DNS.ip, guessed: false,
  });
  assert.deepEqual(recordFor("www.acme.co.uk", DNS), {
    type: "CNAME", name: "www", value: DNS.cname, guessed: false,
  });
});

test("case and a trailing dot are the same name", () => {
  assert.deepEqual(recordFor("WWW.Acme.com.", DNS).name, "www");
});

test("an unplaceable name falls back to A, which is the one that cannot be refused", () => {
  // A record works at an apex and at a subdomain alike; a CNAME works only at a
  // subdomain. So uncertainty must resolve to A — being less future-proof beats
  // being rejected by the registrar.
  const bare = recordFor("localhost", DNS);
  assert.equal(bare.type, "A");
  assert.equal(bare.guessed, true);
  const suffixOnly = recordFor("co.uk", DNS);
  assert.equal(suffixOnly.type, "A");
  assert.equal(suffixOnly.guessed, true);
});
