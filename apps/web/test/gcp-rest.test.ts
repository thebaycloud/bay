import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  tokenExpiresAt,
  tokenUsable,
  encodeObjectName,
  objectsListUrl,
  objectMediaUrl,
  objectInsertUrl,
  runServiceUrl,
  runJobUrl,
  runServicesListUrl,
  imageTag,
  relativeObjectNames,
  serviceListItems,
  serviceListContinue,
  setFallbackTokenSource,
  shouldProbeMetadata,
  listObjectNames,
  readObjectText,
  writeObject,
  describeServiceRest,
  listServicesRest,
  accessToken,
  resetTokenCache,
} from "../lib/gcp-rest";

/* --------------------------------------------------------------------------
 * A fake fetch. Nothing in this file touches the network or a credential: the
 * metadata server is answered by the stub, so no gcloud subprocess ever runs.
 * -------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Call { url: string; init: any }

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init: any) => { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (r.body === undefined ? JSON.parse(r.text ?? "{}") : r.body),
      text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.body ?? {})),
    };
  }) as unknown as typeof fetch;
  return calls;
}

/** The metadata-server reply, so accessToken() resolves without a subprocess. */
function metadataReply() {
  return { body: { access_token: "test-token", expires_in: 3600 } };
}

function isMetadata(url: string) {
  return url.startsWith("http://metadata.google.internal/");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setFallbackTokenSource(null);
  resetTokenCache();
});

/* -------------------------------- expiry -------------------------------- */

test("a token is trusted only until shortly before it really expires", () => {
  const now = 1_000_000;
  // One hour of life, refreshed five minutes early = 55 usable minutes.
  const exp = tokenExpiresAt(3600, now, 5 * 60_000);
  assert.equal(exp, now + 55 * 60_000);

  assert.equal(tokenUsable({ token: "t", expiresAt: exp }, now), true);
  assert.equal(tokenUsable({ token: "t", expiresAt: exp }, exp - 1), true);
  assert.equal(tokenUsable({ token: "t", expiresAt: exp }, exp), false, "expiry is exclusive");
  assert.equal(tokenUsable({ token: "t", expiresAt: exp }, exp + 1), false);
});

test("a token too short-lived to outlive the skew is never usable", () => {
  const now = 1_000_000;
  const exp = tokenExpiresAt(60, now, 5 * 60_000); // 60s of life, 300s of skew
  assert.ok(exp < now, "lands in the past");
  assert.equal(tokenUsable({ token: "t", expiresAt: exp }, now), false);
});

test("an empty or absent token is never usable", () => {
  assert.equal(tokenUsable(null, 0), false);
  assert.equal(tokenUsable({ token: "", expiresAt: Number.MAX_SAFE_INTEGER }, 0), false);
});

test("a nonsense expires_in does not mint an immortal token", () => {
  const now = 1_000_000;
  assert.ok(tokenExpiresAt(Number.NaN, now) <= now);
  assert.ok(tokenExpiresAt(-99999, now) <= now);
});

/* --------------------------- metadata probing ---------------------------- */

test("the metadata server is probed on the first call", () => {
  assert.equal(shouldProbeMetadata(null, 0), true);
});

test("a metadata failure is believed for a while, then re-probed", () => {
  const retry = 5 * 60_000;
  const probe = { ok: false, at: 1_000_000 };
  // Local dev: not paying a 1s timeout on every token refresh.
  assert.equal(shouldProbeMetadata(probe, 1_000_000 + 1, retry), false);
  assert.equal(shouldProbeMetadata(probe, 1_000_000 + retry - 1, retry), false);
  // But one transient blip on Cloud Run must not cost the fast path forever.
  assert.equal(shouldProbeMetadata(probe, 1_000_000 + retry, retry), true);
  assert.equal(shouldProbeMetadata(probe, 1_000_000 + retry * 10, retry), true);
});

test("a metadata success is always re-probed, because we came for a fresh token", () => {
  assert.equal(shouldProbeMetadata({ ok: true, at: 1_000_000 }, 1_000_001), true);
});

/* ------------------------------ URL building ----------------------------- */

test("an object name is escaped for a path segment, slashes included", () => {
  // A bare slash here is a 404: the name is one path segment, not a path.
  assert.equal(encodeObjectName("choqd/r/20260727t202643z-bc8c185c/index.html"),
    "choqd%2Fr%2F20260727t202643z-bc8c185c%2Findex.html");
  assert.equal(encodeObjectName("a b/c+d.html"), "a%20b%2Fc%2Bd.html");
});

test("objects.list asks for one page of names at a time", () => {
  const u = new URL(objectsListUrl("supersonic-static-assets", "myapp/r/rel1/"));
  assert.equal(u.origin + u.pathname, "https://storage.googleapis.com/storage/v1/b/supersonic-static-assets/o");
  assert.equal(u.searchParams.get("prefix"), "myapp/r/rel1/");
  assert.equal(u.searchParams.get("maxResults"), "1000");
  assert.equal(u.searchParams.get("fields"), "items(name),nextPageToken");
  assert.equal(u.searchParams.get("pageToken"), null, "no token on the first page");

  const next = new URL(objectsListUrl("b", "p/", "TOK=="));
  assert.equal(next.searchParams.get("pageToken"), "TOK==");
});

test("reading an object asks for the bytes, not the metadata", () => {
  const u = objectMediaUrl("supersonic-static-assets", "myapp/r/rel1/index.html");
  assert.equal(u,
    "https://storage.googleapis.com/storage/v1/b/supersonic-static-assets/o/myapp%2Fr%2Frel1%2Findex.html?alt=media");
});

test("the pointer write is a simple upload to the upload host", () => {
  const u = new URL(objectInsertUrl("supersonic-static-assets", "myapp/current"));
  assert.equal(u.origin + u.pathname, "https://storage.googleapis.com/upload/storage/v1/b/supersonic-static-assets/o");
  assert.equal(u.searchParams.get("uploadType"), "media");
  assert.equal(u.searchParams.get("name"), "myapp/current");
  // Uniform bucket-level access is on; an ACL here would be rejected outright.
  assert.equal(u.searchParams.get("predefinedAcl"), null);
  assert.equal(u.searchParams.get("acl"), null);
});

test("Cloud Run is addressed on the regional v1 Knative surface", () => {
  // v1, not v2: v1 returns the same resource shape gcloud prints, so every
  // existing reader of metadata.labels / status.url keeps working.
  assert.equal(runServiceUrl("supersonic-static"),
    "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/supersonic-deploy-prod/services/supersonic-static");
  assert.equal(runServicesListUrl(),
    "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/supersonic-deploy-prod/services");
  assert.ok(!runServiceUrl("x").includes("/v2/"));
});

test("runJobUrl targets the Cloud Run Admin v2 jobs resource", () => {
  const url = runJobUrl("supersonic-deploy-job", "proj", "us-central1");
  assert.equal(url, "https://us-central1-run.googleapis.com/v2/projects/proj/locations/us-central1/jobs/supersonic-deploy-job");
});

test("imageTag takes the tag after the last colon, not one inside the host", () => {
  // The registry host may carry a port, and the repository path may not. Splitting
  // on the first colon would read "5000/supersonic/control-plane" as a tag.
  assert.equal(imageTag("us-central1-docker.pkg.dev/p/supersonic/control-plane:abc123"), "abc123");
  assert.equal(imageTag("localhost:5000/supersonic/control-plane:abc123"), "abc123");
});

test("imageTag returns empty for an untagged reference rather than guessing", () => {
  // A digest-pinned or bare reference has no tag. Returning "" makes the caller's
  // comparison fail loudly; inventing "latest" would make two different images
  // compare equal.
  assert.equal(imageTag("us-central1-docker.pkg.dev/p/supersonic/control-plane"), "");
  assert.equal(imageTag("us-central1-docker.pkg.dev/p/supersonic/control-plane@sha256:dead"), "");
});

/* ---------------------------- response shaping --------------------------- */

test("a listing becomes the release-relative paths the verifier expects", () => {
  const prefix = "myapp/r/rel1/";
  const items = [
    { name: "myapp/r/rel1/index.html" },
    { name: "myapp/r/rel1/assets/index-abc.js" },
    { name: "myapp/r/rel1/" },              // the prefix itself
    { name: "myapp/r/rel1/nested/" },       // a directory placeholder
    { name: "myapp/r/other/index.html" },   // a different release
  ];
  assert.deepEqual(relativeObjectNames(items, prefix), ["index.html", "assets/index-abc.js"]);
});

test("a malformed listing yields no names rather than throwing", () => {
  assert.deepEqual(relativeObjectNames([], "p/"), []);
  assert.deepEqual(relativeObjectNames([{}, { name: undefined }] as any, "p/"), []);
  assert.deepEqual(relativeObjectNames(undefined as any, "p/"), []);
});

test("a ServiceList is normalised to the bare array gcloud used to print", () => {
  assert.deepEqual(serviceListItems({ kind: "ServiceList", items: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(serviceListItems([{ a: 1 }]), [{ a: 1 }], "already an array");
  assert.deepEqual(serviceListItems({ kind: "ServiceList" }), []);
  assert.deepEqual(serviceListItems(null), []);
});

/* ------------------------- behaviour, with a stub ------------------------ */

test("a listing follows nextPageToken to the end", async () => {
  const calls = stubFetch((url) => {
    if (isMetadata(url)) return metadataReply();
    const tok = new URL(url).searchParams.get("pageToken");
    if (!tok) return { body: { items: [{ name: "p/a" }, { name: "p/b" }], nextPageToken: "T2" } };
    return { body: { items: [{ name: "p/c" }] } };
  });

  const names = await listObjectNames("bkt", "p/");

  assert.deepEqual(names, ["a", "b", "c"], "a site bigger than one page is not truncated");
  const listCalls = calls.filter((c) => !isMetadata(c.url));
  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0].init.headers.Authorization, "Bearer test-token");
  assert.equal(listCalls[0].init.headers["x-goog-user-project"], "supersonic-deploy-prod");
});

test("an empty release lists as empty, which is not the same as a failure", async () => {
  stubFetch((url) => (isMetadata(url) ? metadataReply() : { body: { kind: "storage#objects" } }));
  assert.deepEqual(await listObjectNames("bkt", "p/"), []);
});

test("a failed listing returns null so the caller falls back to gcloud", async () => {
  stubFetch((url) => (isMetadata(url) ? metadataReply() : { status: 500, body: { error: { message: "boom" } } }));
  assert.equal(await listObjectNames("bkt", "p/"), null);
});

test("reading an object returns its bytes, and null when it is not there", async () => {
  stubFetch((url) => {
    if (isMetadata(url)) return metadataReply();
    return url.includes("index.html") ? { text: "<!doctype html>" } : { status: 404, text: "Not Found" };
  });

  assert.equal(await readObjectText("bkt", "p/index.html"), "<!doctype html>");
  // 404 is null, not "": a missing object must be reported by the old path.
  assert.equal(await readObjectText("bkt", "p/missing.html"), null);
});

test("the pointer is written as raw bytes with no trailing newline", async () => {
  const calls = stubFetch((url) => (isMetadata(url) ? metadataReply() : { body: { name: "myapp/current" } }));

  assert.equal(await writeObject("bkt", "myapp/current", "20260727t202828z-c43d238f"), true);

  const put = calls.filter((c) => !isMetadata(c.url))[0];
  assert.equal(put.init.method, "POST");
  assert.equal(put.init.body, "20260727t202828z-c43d238f");
  assert.equal(put.init.body.length, 25, "no trailing newline — the static server reads this verbatim");
  assert.equal(put.init.headers["Content-Type"], "application/octet-stream");
});

test("a rejected pointer write reports false rather than throwing", async () => {
  stubFetch((url) => (isMetadata(url) ? metadataReply() : { status: 403, body: { error: { message: "denied" } } }));
  assert.equal(await writeObject("bkt", "myapp/current", "rel1"), false);
});

test("a transport error anywhere degrades to a fallback, never an exception", async () => {
  // The token is fine; the API calls die mid-flight. (The token-source failure
  // path is deliberately untested here: exercising it would spawn gcloud, and
  // these tests must not need a credential.)
  stubFetch((url) => {
    if (isMetadata(url)) return metadataReply();
    throw new Error("socket hang up");
  });

  // Every helper says "use gcloud" rather than propagating the error.
  assert.equal(await listObjectNames("bkt", "p/"), null);
  assert.equal(await readObjectText("bkt", "p/index.html"), null);
  assert.equal(await writeObject("bkt", "p/current", "rel"), false);
  assert.equal(await describeServiceRest("supersonic-static"), null);
  assert.equal(await listServicesRest(), null);
});

test("describing a service hands back the Knative resource, and null on an error body", async () => {
  stubFetch((url) => {
    if (isMetadata(url)) return metadataReply();
    return { body: { metadata: { name: "supersonic-static" }, status: { url: "https://x-uc.a.run.app" } } };
  });
  const svc = await describeServiceRest("supersonic-static");
  assert.equal(svc.status.url, "https://x-uc.a.run.app");

  resetTokenCache();
  stubFetch((url) => (isMetadata(url) ? metadataReply() : { status: 404, body: { error: { message: "not found" } } }));
  assert.equal(await describeServiceRest("nope"), null);
});

test("an unrecognised service list is a failure, not an empty project", async () => {
  // Reporting {} as "no services" would let resolveSlug mint a colliding slug.
  stubFetch((url) => (isMetadata(url) ? metadataReply() : { body: { kind: "ServiceList" } }));
  assert.equal(await listServicesRest(), null);

  resetTokenCache();
  stubFetch((url) => (isMetadata(url) ? metadataReply() : { body: { kind: "ServiceList", items: [{ metadata: { name: "a" } }] } }));
  assert.deepEqual(await listServicesRest(), [{ metadata: { name: "a" } }]);
});

test("the token is fetched once and reused across calls", async () => {
  const calls = stubFetch((url) => (isMetadata(url) ? metadataReply() : { body: { items: [] } }));

  await listObjectNames("bkt", "p/");
  await listObjectNames("bkt", "q/");
  await readObjectText("bkt", "p/index.html");

  assert.equal(calls.filter((c) => isMetadata(c.url)).length, 1,
    "one token for the whole deploy, not one per request");
});

test("concurrent callers share a single token fetch", async () => {
  const calls = stubFetch((url) => (isMetadata(url) ? metadataReply() : { body: { items: [] } }));

  await Promise.all([accessToken(), accessToken(), accessToken()]);

  assert.equal(calls.filter((c) => isMetadata(c.url)).length, 1);
});

/* -------------------- the service list pages, like GCS ------------------- */

test("a ServiceList carries a Kubernetes continuation token, or none on the last page", () => {
  assert.equal(serviceListContinue({ kind: "ServiceList", metadata: { continue: "AAZXnvY+3IU" } }), "AAZXnvY+3IU");
  assert.equal(serviceListContinue({ kind: "ServiceList", metadata: { selfLink: "/x" } }), null);
  assert.equal(serviceListContinue({ kind: "ServiceList", metadata: { continue: "" } }), null);
  assert.equal(serviceListContinue([{ a: 1 }]), null, "the gcloud array shape is never partial");
  assert.equal(serviceListContinue(null), null);
});

test("the services URL resumes from a continuation token", () => {
  assert.equal(runServicesListUrl("p", "us-central1", "AAZXnvY+3IU"),
    "https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/p/services?continue=AAZXnvY%2B3IU");
});

test("a truncated service list is followed to the end, not silently cut short", async () => {
  // Proven live: `.../services?limit=2` answers with metadata.continue set.
  // Truncation here is silent and expensive — listServices() would drop a user's
  // apps from the dashboard, and resolveSlug() would mint a fresh slug for an app
  // that already exists, which is the duplicate-app bug all over again.
  const calls = stubFetch((url) => {
    if (isMetadata(url)) return metadataReply();
    const tok = new URL(url).searchParams.get("continue");
    if (!tok) {
      return { body: { kind: "ServiceList", metadata: { continue: "C2" }, items: [{ metadata: { name: "a" } }, { metadata: { name: "b" } }] } };
    }
    return { body: { kind: "ServiceList", metadata: { selfLink: "/x" }, items: [{ metadata: { name: "c" } }] } };
  });

  const svcs = await listServicesRest();

  assert.deepEqual((svcs ?? []).map((s: any) => s.metadata.name), ["a", "b", "c"]);
  assert.equal(calls.filter((c) => !isMetadata(c.url)).length, 2);
});

test("a page that fails mid-listing returns null rather than a partial list", async () => {
  // A partial answer is worse than no answer: every caller reads it as complete.
  stubFetch((url) => {
    if (isMetadata(url)) return metadataReply();
    const tok = new URL(url).searchParams.get("continue");
    if (!tok) return { body: { kind: "ServiceList", metadata: { continue: "C2" }, items: [{ metadata: { name: "a" } }] } };
    return { status: 500, body: { error: { message: "boom" } } };
  });

  assert.equal(await listServicesRest(), null);
});

test("a continuation token that never advances is a failure, not a doubled list", async () => {
  // Spinning forever and counting a page twice are both wrong, so it falls back.
  const calls = stubFetch((url) => (isMetadata(url)
    ? metadataReply()
    : { body: { kind: "ServiceList", metadata: { continue: "SAME" }, items: [{ metadata: { name: "a" } }] } }));

  assert.equal(await listServicesRest(), null);
  assert.equal(calls.filter((c) => !isMetadata(c.url)).length, 2, "it stops on the second page, it does not loop");
});

/* ------------------- a token judged unusable is not served ---------------- */

test("a token too short-lived to cache is not handed to the caller either", async () => {
  // This used to clear the cache and then return the very token it had just
  // rejected. Callers read null as "use gcloud", which works; they have no
  // recovery from a 401.
  setFallbackTokenSource(async () => null);
  stubFetch((url) => (isMetadata(url) ? { body: { access_token: "DEAD", expires_in: 0 } } : { body: {} }));

  assert.equal(await accessToken(), null);
});

test("an unusable metadata token still lets the fallback answer", async () => {
  setFallbackTokenSource(async () => ({ token: "from-gcloud", expiresAt: Date.now() + 60_000 }));
  stubFetch((url) => (isMetadata(url) ? { body: { access_token: "DEAD", expires_in: 0 } } : { body: {} }));

  assert.equal(await accessToken(), "from-gcloud");
});

test("no usable token anywhere means null, which is the gcloud fallback signal", async () => {
  setFallbackTokenSource(async () => null);
  stubFetch((url) => (isMetadata(url) ? { status: 500, body: {} } : { body: {} }));

  assert.equal(await accessToken(), null);
  // And the helpers say "use gcloud" rather than sending a request with no auth.
  assert.equal(await listObjectNames("bkt", "p/"), null);
  assert.equal(await listServicesRest(), null);
  assert.equal(await writeObject("bkt", "p/current", "rel"), false);
});
