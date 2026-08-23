import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What GitHub sent, and whether it really was GitHub.
 *
 * Two things live here and they are the same job seen from two sides: proving
 * the request is genuine, and reading the one event we act on. Both are pure
 * functions of bytes, so the route around them is plumbing — the same split
 * lib/github-import.ts already uses, for the same reason: the decisions that
 * have to be right should be testable without a Request.
 *
 * ## This is the whole security boundary
 *
 * `/api/github/webhook` is exempt from the cookie gate, beside Stripe's. Behind
 * it sits code that can clone a private repository, run a container and deploy
 * to a live address under our own service account. There is no session, no
 * user, and no second check further in — the HMAC is it.
 */

const ZERO_SHA = "0000000000000000000000000000000000000000";

function secret(): string {
  return (process.env.GH_WEBHOOK_SECRET ?? "").trim();
}

/**
 * Whether the platform can verify a delivery at all.
 *
 * Named separately from "is this signature valid" because the two failures are
 * unrelated: an unconfigured platform should answer 503 and say so, while a bad
 * signature is a 401 and says nothing. Collapsing them would make a missing
 * environment variable look like an attack in the logs.
 */
export function webhookConfigured(): boolean {
  return secret().length > 0;
}

/**
 * HMAC-SHA256 over the RAW body.
 *
 * Raw, which is why every caller must read `req.text()` before parsing:
 * re-serialising the parsed JSON produces different bytes — a reordered key, a
 * dropped space — and therefore a signature that can never match, for a body
 * that is byte-identical in every way a person would check.
 *
 * Returns false rather than throwing on every malformed shape: a missing
 * header, a wrong prefix, a digest of the wrong length. `timingSafeEqual`
 * refuses buffers of unequal length outright, so the length is compared first
 * and separately — otherwise a short header would be a thrown exception rather
 * than a rejection, and the route would answer 500 to something it should
 * simply refuse.
 */
export function verifySignature(raw: string, header: string | null | undefined): boolean {
  const key = secret();
  if (!key || !header) return false;
  const expected = "sha256=" + createHmac("sha256", key).update(raw, "utf8").digest("hex");
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One push, reduced to what a build needs to exist. */
export interface Push {
  repoId: number;
  repoFullName: string;
  branch: string;
  sha: string;
  message: string;
  author: string;
  /** The GitHub login that pushed, which is not necessarily whose app this is. */
  senderLogin: string;
}

/**
 * Either the push, or the reason there is nothing to do.
 *
 * A reason rather than a bare null, because it is the answer the route puts in
 * its 200 body — GitHub's *Advanced* tab shows the response for every delivery,
 * and `{"ignored": "not-a-branch"}` is the difference between debugging this in
 * a minute and reading our logs for an hour.
 */
export type PushRead = { ok: true; push: Push } | { ok: false; reason: string };

const s = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Read a push payload.
 *
 * Every refusal here is a normal event that we simply do not ship, not an
 * error: GitHub sends a push for a tag, for a branch being deleted, and for a
 * branch created with no commits, and all three are ordinary things to do to a
 * repository.
 */
export function readPush(payload: unknown): PushRead {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ref = s(p.ref);

  // Tags and notes and anything else that is not a branch. `refs/heads/` is the
  // only prefix a production branch can have, so this is a whitelist rather
  // than a list of things to skip — the difference matters the day GitHub adds
  // a fourth kind of ref.
  if (!ref.startsWith("refs/heads/")) return { ok: false, reason: "not-a-branch" };
  const branch = ref.slice("refs/heads/".length);
  if (!branch) return { ok: false, reason: "not-a-branch" };

  // A deletion arrives as a push whose `after` is all zeroes. Building it would
  // mean cloning a commit that no longer exists on a branch that no longer
  // exists, which fails slowly and reports the failure on nothing.
  const after = s(p.after).toLowerCase();
  if (p.deleted === true || !after || after === ZERO_SHA) return { ok: false, reason: "branch-deleted" };
  if (!/^[0-9a-f]{40}$/.test(after)) return { ok: false, reason: "no-commit" };

  const repo = (p.repository ?? {}) as Record<string, unknown>;
  const repoId = typeof repo.id === "number" ? repo.id : Number(s(repo.id));
  if (!Number.isInteger(repoId) || repoId <= 0) return { ok: false, reason: "no-repository" };

  const head = (p.head_commit ?? {}) as Record<string, unknown>;
  const author = (head.author ?? {}) as Record<string, unknown>;
  const sender = (p.sender ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    push: {
      repoId,
      repoFullName: s(repo.full_name),
      branch,
      sha: after,
      // First line only. The rest of a commit message is prose and this value
      // goes in a column a timeline renders on one line; carrying the body
      // would mean every reader had to trim it, and one of them would forget.
      message: s(head.message).split("\n")[0].slice(0, 500),
      // `head_commit.author.name` rather than the sender: the person who wrote
      // the commit is what a timeline should show, and on a merge queue or a
      // rebase-and-merge the two are different people.
      author: s(author.name) || s(author.username),
      senderLogin: s(sender.login),
    },
  };
}
