import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  appJwt, installationToken, githubAppConfigured,
  GithubError, _resetTokenCache, type MintDeps,
} from "../lib/github-app";

/**
 * The credential.
 *
 * Two things are worth asserting and nothing else is. First, that the JWT we
 * sign is one GitHub's rules accept — RS256, our App ID as issuer, a lifetime
 * inside their ten-minute cap. Second, that a token is minted ONCE per hour and
 * that every way GitHub can say no is told apart, because the three refusals
 * have three different answers and a person acting on the wrong one loses an
 * afternoon.
 *
 * What is NOT tested here is that GitHub honours any of it. That is somebody
 * else's server, and the end-to-end check belongs in a script (npm run
 * github:check), not a unit test.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/**
 * Run `fn` with these env vars set, then put the environment back.
 *
 * The restore has to wait for an async `fn` to SETTLE, not merely to return.
 * A plain try/finally around `fn()` restores at the first `await` inside it,
 * so a second call to the module under test sees an unconfigured platform and
 * fails with an error about credentials that were there a microtask ago. That
 * happened, to three of the tests below, and the fix belongs here rather than
 * in each of them.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  let out: T;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof (out as { then?: unknown }).then === "function") {
    return (out as unknown as Promise<unknown>).then(
      (v) => { restore(); return v; },
      (e) => { restore(); throw e; },
    ) as unknown as T;
  }
  restore();
  return out;
}

const CONFIGURED = { GH_APP_ID: "4680812", GH_APP_PRIVATE_KEY: PEM };

test("configured only when both the id and the key are present", () => {
  withEnv(CONFIGURED, () => assert.equal(githubAppConfigured(), true));
  withEnv({ ...CONFIGURED, GH_APP_PRIVATE_KEY: undefined }, () => assert.equal(githubAppConfigured(), false));
  withEnv({ ...CONFIGURED, GH_APP_ID: "" }, () => assert.equal(githubAppConfigured(), false));
});

test("the jwt is RS256, issued by the app, and expires inside GitHub's cap", () => {
  const jwt = withEnv(CONFIGURED, () => appJwt(1_000_000));
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "4680812");
  // Backdated: GitHub rejects a token whose iat is in ITS future, and the two
  // clocks are not the same clock.
  assert.ok(payload.iat <= 1000 - 30, `iat ${payload.iat} not backdated`);
  assert.ok(payload.exp - payload.iat <= 600, "lifetime over GitHub's 10-minute cap");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")), "signature does not verify");
});

test("a private key with escaped newlines is still a usable key", () => {
  // Cloud Run mounts real newlines; a hand-set env var often carries \n. Both
  // have to sign, or the failure is a 401 that looks like a bad App.
  const escaped = PEM.replace(/\n/g, "\\n");
  const jwt = withEnv({ ...CONFIGURED, GH_APP_PRIVATE_KEY: escaped }, () => appJwt(1_000_000));
  const [h, p, s] = jwt.split(".");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")));
});

function mint(status: number, body: unknown, calls: { n: number }): MintDeps {
  return {
    fetch: (async () => {
      calls.n++;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch,
    now: () => 1_000_000,
  };
}

test("a minted token is reused until it is close to expiring", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  const deps = mint(201, { token: "ghs_abc", expires_at: new Date(1_000_000 + 3600_000).toISOString() }, calls);
  await withEnv(CONFIGURED, async () => {
    assert.equal(await installationToken(155650459, deps), "ghs_abc");
    assert.equal(await installationToken(155650459, deps), "ghs_abc");
    assert.equal(calls.n, 1, "minted twice for one installation inside the hour");
  });
});

test("a token inside the safety margin is minted again", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  // Expires in 60s. The margin is 120s, so it is already unusable.
  const deps = mint(201, { token: "ghs_stale", expires_at: new Date(1_000_000 + 60_000).toISOString() }, calls);
  await withEnv(CONFIGURED, async () => {
    await installationToken(155650459, deps);
    await installationToken(155650459, deps);
    assert.equal(calls.n, 2, "a nearly-expired token was reused");
  });
});

test("two installations do not share a cache entry", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  const deps = mint(201, { token: "ghs_x", expires_at: new Date(1_000_000 + 3600_000).toISOString() }, calls);
  await withEnv(CONFIGURED, async () => {
    await installationToken(1, deps);
    await installationToken(2, deps);
    assert.equal(calls.n, 2);
  });
});

test("404 means the installation is gone — the person reinstalls", async () => {
  _resetTokenCache();
  const deps = mint(404, { message: "Not Found" }, { n: 0 });
  await withEnv(CONFIGURED, async () => {
    const e = await installationToken(999, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "no-installation");
  });
});

test("401 means our credentials are wrong — nothing the person does helps", async () => {
  _resetTokenCache();
  const deps = mint(401, { message: "Integration must generate a public key" }, { n: 0 });
  await withEnv(CONFIGURED, async () => {
    const e = await installationToken(1, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "bad-credentials");
  });
});

test("a 500 is neither of those and must not read as one", async () => {
  _resetTokenCache();
  const deps = mint(500, { message: "Server Error" }, { n: 0 });
  await withEnv(CONFIGURED, async () => {
    const e = await installationToken(1, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "unavailable");
  });
});

test("an unconfigured platform fails before it reaches the network", async () => {
  _resetTokenCache();
  const calls = { n: 0 };
  const deps = mint(201, {}, calls);
  await withEnv({ GH_APP_ID: undefined, GH_APP_PRIVATE_KEY: undefined }, async () => {
    const e = await installationToken(1, deps).then(() => null, (x) => x);
    assert.ok(e instanceof GithubError);
    assert.equal(e.refusal.kind, "bad-credentials");
    assert.equal(calls.n, 0, "asked GitHub without a credential to ask with");
  });
});
