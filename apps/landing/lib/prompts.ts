import { BRAND, CLI, DOMAIN, PKG, SITE } from "./brand";
import { rules } from "./prompt-rules";

/**
 * Every prompt and instruction document this site hands to a coding agent.
 *
 * They were spread across three files and restated the same rules in each: the
 * secrets line appeared in four places, the `✓ live:` success criterion in five.
 * A rule that lives in five files is a rule that gets fixed in one of them.
 *
 * So RULES below is the single copy of each shared sentence, and the prompts are
 * composed from it. The prompts themselves stay distinct on purpose: onboarding
 * a first-timer, deploying one named template, and asking which project to
 * self-host are three different jobs, and collapsing them into one generic
 * prompt would make all three worse.
 *
 * ENGLISH ONLY, and not in the message catalogues. These are read by coding
 * agents, which work in English, and they contain commands that get copied
 * verbatim. A translated prompt is a broken prompt.
 *
 * NOT SECRET, and cannot be. The onboarding prompt ships in the client bundle
 * because the copy button runs in the browser; the documents below are public
 * GETs. They instruct an agent ABOUT handling secrets and contain none.
 */

/**
 * Where the manual lives, for an agent.
 *
 * The bare apex, not `/llms.txt`. The root serves the manual to anything that is
 * not a browser (lib/wants-markdown.ts, which matches curl, wget, httpie and the
 * node/undici/axios user-agents most agent tooling sends), so this is one address
 * to remember and it is the one on the tin.
 *
 * Browser-facing links must still say `/llms.txt`: a person clicking the apex
 * gets the landing page, which is the whole point of the negotiation.
 */
export const MANUAL = SITE;

/** The generic self-hosting instructions, for any project rather than a listed one. */
export const SELFHOST_DOC = `${SITE}/selfhost.md`;

/** Where an agent reads the canonical instructions for one template. */
export function agentDoc(slug: string): string {
  return `${SITE}/templates/${slug}/agent.md`;
}

/**
 * The shared rules, with this app's names in them.
 *
 * The sentences live in packages/prompts/rules.ts and are copied into
 * lib/prompt-rules.ts by scripts/sync-prompt-rules.mjs, so apps/web composes its
 * prompts from the same text. See that script for why it is a copy.
 */
export const RULES = rules({ brand: BRAND, cli: CLI, pkg: PKG });

/**
 * The landing page's one prompt, on the hero button and in the dialog.
 *
 * The longest of the three because it is the only one written for someone who
 * has not used {BRAND} before: it carries the whole path rather than pointing at
 * a document, since a first-timer's agent should not need a second fetch to get
 * the first deploy right. It still names the manual for everything else.
 */
export function onboardPrompt(): string {
  return [
    `You are putting my app online with ${BRAND}. The manual is at ${MANUAL} (curl it). ` +
      `Work from my project's root folder. ${RULES.plain}`,
    ``,
    `1. ${RULES.install}`,
    ``,
    `2. Ship it, and WAIT for the answer:`,
    `   ${CLI} ship --wait`,
    `   The first run opens a browser for me to sign in. ${RULES.wait}`,
    ``,
    `3. ${RULES.green}`,
    ``,
    `4. ${RULES.private}`,
    ``,
    `${RULES.dotenv} ${RULES.injected}`,
    ``,
    `${RULES.secrets}`,
  ].join("\n");
}

/**
 * One named template.
 *
 * Deliberately short, and it does not contain the instructions: it points at
 * agent.md, so a broken template is fixed by editing markdown rather than by
 * asking everyone who already copied a prompt to copy it again.
 */
export function templatePrompt(name: string, slug: string): string {
  return `Self-host ${name} on ${BRAND} (${SITE}).

Read ${agentDoc(slug)} and follow it exactly. It is the canonical instructions and it supersedes anything you already believe about deploying this project.

${RULES.plain} ${RULES.secrets}`;
}

/**
 * Any open source project, rather than one of the three we happened to list.
 *
 * The first move is a question, because the free year applies to any public repo
 * and a list is only ever a list of things we wrote down.
 */
export function selfhostPrompt(): string {
  return `I want to self-host an open source project on ${BRAND} (${SITE}).

Ask me which project, then read ${SELFHOST_DOC} and follow it exactly.

${RULES.plain} ${RULES.secrets}`;
}

/** Kept so the cutover block in lib/brand.ts stays the only place names live. */
export { BRAND, CLI, DOMAIN, PKG, SITE };
