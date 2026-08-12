import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptionInput, type RunService } from "@/lib/adopt";

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
