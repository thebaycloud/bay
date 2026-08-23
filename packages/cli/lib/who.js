"use strict";
/**
 * Who is shipping, as declared — never as inferred.
 *
 * An agent sets BAY_WHO=agent (SUPERSONIC_WHO still works). Nothing else is consulted: a TTY check
 * would call CI an agent, and the platform would then draw a figure that was
 * never there. The absence of a name is a fact; a wrong name is a lie.
 */
function whoHeader(env) {
  const v = String(env.BAY_WHO || env.SUPERSONIC_WHO || "").trim().toLowerCase();
  return v === "you" || v === "agent" || v === "platform" ? v : "someone";
}

module.exports = { whoHeader };
