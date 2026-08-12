import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptionInput, imageBelongsTo, servedByStatic, type RunService } from "@/lib/adopt";

const service = (over: Partial<RunService["spec"]["template"]["spec"]["containers"][0]> = {}): RunService => ({
  spec: {
    template: {
      metadata: { annotations: {} },
      spec: {
        containers: [{
          image: "us-central1-docker.pkg.dev/p/cloud-run-source-deploy/shop:latest",
          ports: [{ containerPort: 8080 }],
          resources: { limits: { cpu: "1", memory: "2Gi" } },
          env: [
            { name: "SUPERSONIC_URL", value: "https://shop.supersonic.cv" },
            { name: "PGHOST", value: "127.0.0.1" },
            { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "app-shop-DATABASE_URL", key: "latest" } } },
          ],
          ...over,
        }],
      },
    },
  },
});

// THE ONE THING THAT CANNOT BE COPIED. On Cloud Run the database is a sidecar on
// 127.0.0.1; on a node it is one proxy per host at 10.200.0.1, reached over the
// sandbox bridge because every sandbox has its own loopback. An adoption that
// carried the env across verbatim would produce an app that starts, passes a
// health check on "/", and fails every request that touches data — which is the
// failure the whole secret-and-database path is built to refuse.
test("the database address is restated for the fleet, never carried over", () => {
  const i = adoptionInput("shop", service());
  const env = Object.fromEntries(i.env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  assert.equal(env.PGHOST, "10.200.0.1", "127.0.0.1 is the Cloud Run sidecar and is nowhere on a node");
});

// Everything that is not the platform's database env belongs to the app and
// survives untouched. `SUPERSONIC_URL` is the app's own address and is the same
// on either runtime.
test("the app's own variables are carried across unchanged", () => {
  const i = adoptionInput("shop", service());
  assert.equal(i.env.includes("SUPERSONIC_URL=https://shop.supersonic.cv"), true);
});

// References, never values — the invariant §8 states and this path must not be
// the one that breaks it. A secret arrives as a name and stays a name.
test("secrets stay references", () => {
  const i = adoptionInput("shop", service());
  assert.deepEqual(i.secrets, [{ key: "DATABASE_URL", name: "app-shop-DATABASE_URL" }]);
  assert.equal(JSON.stringify(i).includes("postgres://"), false);
});

test("port, memory and cpu are read from the service rather than defaulted", () => {
  const i = adoptionInput("shop", service());
  assert.equal(i.port, 8080);
  assert.equal(i.memoryBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(i.cpuShares, 1024);
});

// `:latest` is a tag, and a release built on a tag is a release that means
// something different tomorrow. Adoption records what the tag means NOW, which
// is the same rule the deploy path already applies to its own builds.
test("the image is reported as needing a digest, not passed on as a tag", () => {
  const i = adoptionInput("shop", service());
  assert.equal(i.image, "us-central1-docker.pkg.dev/p/cloud-run-source-deploy/shop:latest");
  assert.equal(i.imageIsTag, true);
});

// An app with no database has no database env to restate, and inventing one
// would point it at a proxy it never uses.
test("an app without a database gains no database variables", () => {
  const plain = service({ env: [{ name: "TOKEN", value: "x" }] });
  const i = adoptionInput("shop", plain);
  assert.equal(i.env.some((e) => e.startsWith("PGHOST=")), false);
  assert.deepEqual(i.env, ["TOKEN=x"]);
});

// THE FAILURE THAT REVERTED THE FIRST ADOPTION, and the reason a 401 proved
// nothing about it.
//
// `sh3ar` carries its DSN as a PLAIN value, in Cloud Run's unix-socket form:
//
//   postgresql://user:pw@/sh3ar?host=/cloudsql/<project>:<region>:<instance>
//
// That socket is mounted by the `cloudsql-instances` annotation and exists
// nowhere on a node, where the database is one TCP proxy per host. The first
// version of this module rewrote PGHOST and its siblings and left the DSN
// alone — because a DSN is not a host variable — so the app was placed, started,
// listened, and answered 500 to everything. The edge returned 401 either way,
// because the sign-in gate fires before the upstream is ever called: nothing
// observable from outside changed.
test("a socket-form DSN is rewritten to the fleet's TCP address", () => {
  const svc = service({
    env: [{ name: "DATABASE_URL", value: "postgresql://app_shop:s3cr3t@/shop?host=/cloudsql/p:us-central1:pg" }],
  });
  const i = adoptionInput("shop", svc);
  const dsn = i.env.find((e) => e.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  assert.equal(dsn, "postgresql://app_shop:s3cr3t@10.200.0.1:5432/shop");
});

// A DSN already in TCP form still has to move: 127.0.0.1 is Cloud Run's sidecar.
test("a TCP DSN pointed at the sidecar is repointed, not left alone", () => {
  const svc = service({
    env: [{ name: "DATABASE_URL", value: "postgresql://u:p@127.0.0.1:5432/shop?sslmode=disable" }],
  });
  const i = adoptionInput("shop", svc);
  const dsn = i.env.find((e) => e.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length);
  assert.match(dsn, /@10\.200\.0\.1:5432\/shop/);
  assert.match(dsn, /sslmode=disable/, "the app's own query parameters survive");
});

// An external database is the app's own business. Supabase, Neon, anywhere —
// rewriting that host would take a working app off its data.
test("a database that is not ours is left exactly as it is", () => {
  const dsn = "postgresql://u:p@db.supabase.co:5432/postgres";
  const svc = service({ env: [{ name: "DATABASE_URL", value: dsn }] });
  const i = adoptionInput("shop", svc);
  assert.equal(i.env.find((e) => e.startsWith("DATABASE_URL="))!.slice("DATABASE_URL=".length), dsn);
});

// WHAT MUST NOT BE ADOPTED, learned by adopting it.
//
// Five apps were marked `fleet` in one batch and reverted before the reconciler
// acted, because four of them shared ONE image:
// `cloud-run-source-deploy/runner-node@sha256:82df02…`. That is the runner
// lane's shared prebuilt: the app's code is not in it at all, it is in a bundle
// fetched at start. Placing that on a node places an empty runtime.
//
// The rule is not "is it the runner image" — that name will change. It is that
// an app's image must BELONG to the app, which is checkable against the slug.
test("an image that is not this app's own is refused", () => {
  const shared = "us-central1-docker.pkg.dev/p/cloud-run-source-deploy/runner-node@sha256:abc";
  assert.equal(imageBelongsTo("nqmbk", shared), false);
  assert.equal(imageBelongsTo("nqmbk", "us-central1-docker.pkg.dev/p/cloud-run-source-deploy/nqmbk@sha256:abc"), true);
  assert.equal(imageBelongsTo("nqmbk", "us-central1-docker.pkg.dev/p/cloud-run-source-deploy/nqmbk:latest"), true);
});

// A static app is served by `supersonic-static`, not by a container of its own.
// There is nothing to place, and ADR 0001 keeps static on Cloud Run on purpose.
test("a static app is refused, because there is no container to move", () => {
  assert.equal(servedByStatic("https://supersonic-static-uyuwsbguuq-uc.a.run.app"), true);
  assert.equal(servedByStatic("https://o6b54-uyuwsbguuq-uc.a.run.app"), false);
  assert.equal(servedByStatic(null), false);
});
