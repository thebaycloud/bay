import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The published description and the code it describes, held to each other.
 *
 * An OpenAPI document is a promise, and the failure mode of a hand-written one
 * is not that it is wrong on the day it is written — it is that a route moves
 * six weeks later and nothing says so. So this reads the artifact that actually
 * ships, `public/openapi.json`, and checks it against the route files on disk
 * and against the calls packages/cli makes. Both directions:
 *
 *   - every path in the spec has a route file, and that file exports the
 *     methods the spec claims,
 *   - every path the CLI calls appears in the spec.
 *
 * The second is the one that catches the real drift. A new CLI command is a new
 * part of the public surface whether or not anybody remembered to describe it.
 *
 * Reading `public/openapi.json` rather than packages/openapi/spec.mjs is
 * deliberate: the copy is what is served, and `scripts/sync-openapi.mjs --check`
 * in CI is what keeps it equal to the source. Testing the source would leave the
 * one file the world sees untested.
 */

const WEB = join(__dirname, "..");
const REPO = join(WEB, "..", "..");
const spec = JSON.parse(readFileSync(join(WEB, "public/openapi.json"), "utf8"));

/** `/api/apps/{slug}/env` -> `app/api/apps/[slug]/env/route.ts`. */
function routeFileFor(path: string): string {
  const segments = path.replace(/^\//, "").split("/");
  const dirs = segments.map((s) => s.replace(/^\{(.+)\}$/, "[$1]"));
  return join(WEB, "app", ...dirs, "route.ts");
}

const METHODS = ["get", "post", "put", "delete", "patch"] as const;

test("the document is an OpenAPI document", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.info?.title);
  assert.ok(spec.info?.version);
  assert.ok(Array.isArray(spec.servers) && spec.servers.length > 0);
  assert.ok(spec.components?.securitySchemes?.bearerAuth);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
});

test("every documented path has a route file that exports the documented methods", () => {
  for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
    const file = routeFileFor(path);
    assert.ok(existsSync(file), `${path} is documented and has no route file at ${file}`);
    const source = readFileSync(file, "utf8");
    for (const method of METHODS) {
      if (!(method in item)) continue;
      // Two spellings in this codebase and both are exports: a plain
      // `export async function GET`, and `export const GET = withCors(handler)`
      // where the handler is wrapped. Matching only the first one made this test
      // fail on the routes that answer CORS, which is every route the browser
      // client calls.
      const M = method.toUpperCase();
      const exported =
        new RegExp(`export\\s+(async\\s+)?function\\s+${M}\\b`).test(source) ||
        new RegExp(`export\\s+const\\s+${M}\\s*=`).test(source);
      assert.ok(exported, `${method.toUpperCase()} ${path} is documented and ${file} does not export it`);
    }
  }
});

test("every documented operation has an operationId, and they are unique", () => {
  const seen = new Set<string>();
  for (const [path, item] of Object.entries<Record<string, { operationId?: string }>>(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      assert.ok(op.operationId, `${method.toUpperCase()} ${path} has no operationId`);
      assert.ok(!seen.has(op.operationId!), `duplicate operationId ${op.operationId}`);
      seen.add(op.operationId!);
    }
  }
});

test("every documented error response uses the house error schema", () => {
  for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      for (const [status, response] of Object.entries<any>(op.responses)) {
        if (Number(status) < 400) continue;
        const json = response.content?.["application/json"];
        if (!json) continue; // the three text/plain endpoints say so in their own words
        // Either the Error schema, or an allOf that includes it: two handlers
        // send a defaulted empty list beside the error so the dashboard does not
        // have to branch, and that is still the house error shape with a key
        // added rather than a second shape.
        const schema = json.schema ?? {};
        const refs = schema.$ref ? [schema.$ref] : (schema.allOf ?? []).map((s: any) => s.$ref);
        assert.ok(
          refs.includes("#/components/schemas/Error"),
          `${method.toUpperCase()} ${path} ${status} answers JSON that is not the Error schema`,
        );
      }
    }
  }
});

/**
 * Every distinct `/api/...` the CLI asks for, with its template holes squashed
 * back to the spec's spelling. `${app}` and `${slug}` are the same parameter
 * under two local names.
 */
function pathsTheCliCalls(): Set<string> {
  const source = readFileSync(join(REPO, "packages/cli/index.js"), "utf8");
  const found = new Set<string>();
  for (const m of source.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)) {
    let p = m[1];
    p = p.split("?")[0].replace(/\$\{[^}]+\}/g, "{slug}").replace(/\/$/, "");
    if (!p.startsWith("/api/")) continue;
    found.add(p);
  }
  return found;
}

test("every API path the CLI calls is in the published description", () => {
  const documented = new Set(Object.keys(spec.paths));
  const undocumented = [...pathsTheCliCalls()].filter((p) => !documented.has(p));
  assert.deepEqual(
    undocumented,
    [],
    `the CLI calls these and the spec does not describe them:\n  ${undocumented.join("\n  ")}`,
  );
});

test("the description is not accidentally empty", () => {
  assert.ok(Object.keys(spec.paths).length >= 20, "the spec lost paths");
});
