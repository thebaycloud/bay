/**
 * Who caused a build: you, an agent, the platform — or `someone`, when nobody
 * said.
 *
 * The tempting implementation reads a TTY and calls the answer `agent` when
 * there isn't one. CI has no TTY either, so that reports an agent where there
 * was none, in the one field the whole surface exists to show. An honest blank
 * costs less than a confident lie.
 */
export type Who = "you" | "agent" | "platform" | "someone";

const DECLARED: readonly string[] = ["you", "agent", "platform"];

export function normaliseWho(declared: string | null | undefined): Who {
  const v = (declared ?? "").trim().toLowerCase();
  return (DECLARED.includes(v) ? v : "someone") as Who;
}
