"use strict";

/**
 * What `bay share` was asked to do, decided before anything is sent.
 *
 * Access is the one command in this CLI where a misread argument does damage
 * that is not visible afterwards: `share app add acme.com` meant as "everyone at
 * my company" and read as an email address would fail loudly, which is fine —
 * but read the other way round it would let a whole domain into an app the
 * owner meant to send to one person, and nothing on screen would look wrong.
 * So the reading is a pure function with tests, and the network call is what
 * happens after it.
 *
 * The two audiences are told apart by shape, not by a flag:
 *
 *   ada@acme.com   an address        -> one person, invited by email
 *   @acme.com      a rule            -> everyone whose address ends in it
 *   acme.com       the same rule     -> the @ is how people write it, not a requirement
 *
 * A bare word with no dot is neither, and is refused rather than guessed at.
 */

/** The three visibilities the control plane accepts, in the order they widen. */
const VISIBILITIES = ["private", "shared", "public"];

/**
 * @param {string} who
 * @returns {{audience: "email"|"domain", value: string}|null}
 */
function audienceOf(who) {
  const w = String(who ?? "").trim().toLowerCase();
  if (!w) return null;

  // An @ anywhere but the front makes it an address. RFC 5321 caps a mailbox at
  // 254 characters; past that it is not an address that could ever be delivered
  // to, and the server refuses it — better said here, where the reason fits on
  // one line.
  if (w.includes("@") && !w.startsWith("@")) {
    if (w.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(w)) return null;
    return { audience: "email", value: w };
  }

  const domain = w.replace(/^@/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return { audience: "domain", value: domain };
}

/**
 * @param {string[]} rest  the arguments after the app name
 * @returns {{kind: "show"}
 *          |{kind: "visibility", visibility: string}
 *          |{kind: "add"|"remove", audience: "email"|"domain", value: string}
 *          |{kind: "error", why: string}}
 */
function parseShare(rest) {
  const [verb, ...targets] = (rest || []).filter((t) => t !== undefined && t !== null);
  if (!verb) return { kind: "show" };

  const v = String(verb).trim().toLowerCase();
  if (VISIBILITIES.includes(v)) return { kind: "visibility", visibility: v };

  if (v === "add" || v === "remove" || v === "rm") {
    const kind = v === "rm" ? "remove" : v;
    if (!targets.length) {
      return { kind: "error", why: `who? usage: bay share <app> ${kind} <email|@domain>` };
    }
    const audience = audienceOf(targets[0]);
    if (!audience) {
      return {
        kind: "error",
        why: `"${targets[0]}" is neither an email address nor a domain — write ada@acme.com for one person, or @acme.com for everyone there`,
      };
    }
    return { kind, ...audience };
  }

  return {
    kind: "error",
    why: `unknown: share ${v}\nusage: bay share <app> [private|shared|public | add <email|@domain> | remove <email|@domain>]`,
  };
}

/**
 * The request body for an add/remove, in the shape the control plane's share
 * route reads. Kept beside the parser because the four field names — addEmail,
 * addDomain, removeEmail, removeDomain — are the only thing connecting the two.
 */
function shareBody(action) {
  const suffix = action.audience === "email" ? "Email" : "Domain";
  return { [action.kind + suffix]: action.value };
}

module.exports = { parseShare, audienceOf, shareBody, VISIBILITIES };
