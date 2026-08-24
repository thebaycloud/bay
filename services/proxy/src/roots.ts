/**
 * The roots this edge answers for, canonical first.
 *
 * Its own module, and not a field on `config`, for one reason: `config.ts` calls
 * `required("AUTH_SECRET")` at import time and throws without it. So anything
 * that imports config to learn the root domain becomes a module you cannot load
 * without a secret — which is how a pure header transform came to need
 * AUTH_SECRET to be unit-tested.
 *
 * Same contract as `apps/web/lib/roots.ts`, and the same reason for the plural:
 * `thebay.cloud` is the name from here on and `supersonic.cv` is what three live
 * apps and every installed CLI still point at, so both answer at once.
 *
 * ORDER IS MEANING. The first is canonical — the one new addresses are minted
 * under, the one the workbench frames from, the one a person is told to CNAME at.
 */
export const CANONICAL_ROOT = "thebay.cloud";
export const LEGACY_ROOT = "supersonic.cv";

export function rootDomains(): string[] {
  const raw = process.env.ROOT_DOMAINS ?? process.env.ROOT_DOMAIN ?? `${CANONICAL_ROOT},${LEGACY_ROOT}`;
  const roots = raw
    .split(",")
    .map((r) => r.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  // Never empty. With no roots the door refuses no hostname, and the namespace
  // we issue is open for anyone to claim.
  return roots.length ? Array.from(new Set(roots)) : [CANONICAL_ROOT, LEGACY_ROOT];
}

/** The root new addresses are minted under. */
export function rootDomain(): string {
  return rootDomains()[0];
}
