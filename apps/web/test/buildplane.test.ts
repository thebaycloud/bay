import { test } from "node:test";
import assert from "node:assert/strict";
import { buildctlArgs, dockerAuthConfig, buildPlaneHost } from "@/lib/buildplane";

const base = {
  dir: "/w/src",
  image: "us-central1-docker.pkg.dev/p/r/shop",
  addr: "tcp://10.128.0.5:1234",
};

// The plan is executed by Railpack's own BuildKit frontend, fetched by the
// daemon. `--local dockerfile` names the DIRECTORY holding railpack-plan.json,
// not the file — buildctl's vocabulary, and getting it wrong points the frontend
// at a directory with no plan in it.
test("the frontend is fetched by the daemon and pointed at the plan's directory", () => {
  const a = buildctlArgs(base);
  assert.equal(a.includes("--frontend"), true);
  assert.equal(a[a.indexOf("--frontend") + 1], "gateway.v0");
  assert.equal(a.includes("source=ghcr.io/railwayapp/railpack-frontend"), true);
  assert.equal(a.includes("context=/w/src"), true);
  assert.equal(a.includes("dockerfile=/w/src"), true);
});

// Pushed straight from the daemon. The image never lands on the deploy job's
// disk, which is the point of moving the build off it — and `push=true` is what
// makes the difference between a build and a build that produced something.
test("the image is pushed by the daemon, tagged the way the pipeline expects", () => {
  const a = buildctlArgs(base);
  const out = a[a.indexOf("--output") + 1];
  assert.match(out, /^type=image,/);
  assert.match(out, /name=us-central1-docker\.pkg\.dev\/p\/r\/shop:latest/);
  assert.match(out, /push=true/);
});

// mTLS is not optional and must not be forgettable: a missing --tlscert against
// a daemon that requires one fails with a handshake error naming neither the
// certificate nor the build. All three are emitted together or the caller could
// send two.
test("all three certificate flags travel together", () => {
  const a = buildctlArgs({ ...base, certDir: "/buildkit" });
  assert.equal(a[a.indexOf("--tlscacert") + 1], "/buildkit/ca/ca.pem");
  assert.equal(a[a.indexOf("--tlscert") + 1], "/buildkit/cert/client.pem");
  assert.equal(a[a.indexOf("--tlskey") + 1], "/buildkit/key/client-key.pem");
});

// The daemon keeps its cache locally, so nothing needs exporting to a registry
// — that registry round trip is exactly what this replaces. An inline export is
// still worth having: it costs nothing and lets a build elsewhere start warm.
test("the cache is the daemon's own, with an inline copy in the image", () => {
  const a = buildctlArgs(base);
  assert.equal(a.includes("--export-cache"), true);
  assert.equal(a[a.indexOf("--export-cache") + 1], "type=inline");
  assert.equal(a.join(" ").includes("type=registry"), false, "the registry cache is what we are leaving");
});

// Build args reach the frontend as `build-arg:` options — buildctl's spelling,
// which is not `--build-arg`.
test("build args use buildctl's spelling, not docker's", () => {
  const a = buildctlArgs({ ...base, buildArgs: [{ key: "NEXT_PUBLIC_BASE_PATH", value: "/app" }] });
  assert.equal(a.includes("build-arg:NEXT_PUBLIC_BASE_PATH=/app"), true);
});

// Registry credentials come from the CLIENT and are sent to the daemon, so the
// daemon needs no identity of its own in the registry — which is why the build
// host holds no long-lived push credential.
test("the daemon pushes with the job's own token, not with an identity of its own", () => {
  const cfg = JSON.parse(dockerAuthConfig("us-central1-docker.pkg.dev", "ya29.token"));
  const entry = cfg.auths["us-central1-docker.pkg.dev"];
  assert.equal(Buffer.from(entry.auth, "base64").toString(), "oauth2accesstoken:ya29.token");
});

// Absent means "use Cloud Build", which is the behaviour in production today.
// An empty string must not read as a host — that is how a build ends up dialling
// nothing and reporting a connection error instead of taking the old path.
test("no host configured means the old path, and an empty one is not a host", () => {
  assert.equal(buildPlaneHost({}), null);
  assert.equal(buildPlaneHost({ BUILDKIT_HOST: "" }), null);
  assert.equal(buildPlaneHost({ BUILDKIT_HOST: "  " }), null);
  assert.equal(buildPlaneHost({ BUILDKIT_HOST: "tcp://10.128.0.5:1234" }), "tcp://10.128.0.5:1234");
});
