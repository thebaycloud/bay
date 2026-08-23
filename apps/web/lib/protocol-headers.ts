/**
 * The headers the CLI sends, read under either spelling.
 *
 * ## Why both, and for how long
 *
 * This is a contract with software we do not control. `supersonic-cli` is a
 * copy in somebody's global npm directory; it sends `x-supersonic-app` and will
 * go on doing so until its owner runs an upgrade, which for a working tool is
 * often never. Renaming the headers server-side would break every one of those
 * installs on the day of the deploy, with no error a person could act on —
 * `x-bay-app` absent simply means "no app name was given", and the deploy would
 * fail somewhere much later for a reason that names the wrong thing.
 *
 * So the server reads either and prefers the new one. The old prefix comes out
 * when the logs show nobody is sending it: a decision from evidence, months
 * from now, and deliberately not part of this change.
 *
 * ## Why a function and not a rename with a fallback at each call site
 *
 * There are ten of these on `/api/deploy` alone. Ten hand-written `??` chains
 * are ten chances to forget one, and forgetting one is a CLI feature that
 * silently stops working for everybody who has not upgraded — which reads as
 * the feature being removed rather than a header being renamed.
 */

export const PROTOCOL_PREFIX = "x-bay-";
export const LEGACY_PROTOCOL_PREFIX = "x-supersonic-";

/**
 * One protocol header, new name first.
 *
 * `null` means neither was sent. An empty string means one was sent and was
 * empty — a distinction the deploy route depends on, because an empty
 * `slug` is a caller asking for a generated one and a missing `slug` is a
 * caller that does not know about slugs.
 *
 * An empty NEW header does not shadow a populated old one: a CLI that sets its
 * headers unconditionally sends `""` when it has nothing to say, and letting
 * that win would throw away a value the caller did provide.
 */
export function protocolHeader(req: Request, name: string): string | null {
  const fresh = req.headers.get(PROTOCOL_PREFIX + name);
  if (fresh !== null && fresh !== "") return fresh;
  const legacy = req.headers.get(LEGACY_PROTOCOL_PREFIX + name);
  if (legacy !== null) return legacy;
  return fresh;
}
