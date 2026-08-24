import { BRAND, CLI, DOMAIN, PKG, SITE } from "./brand";

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
 * The sentences more than one prompt or document needs.
 *
 * Each is a complete thought that can be dropped into a numbered list or a
 * paragraph without rewording. Edit one here and every prompt follows.
 */
export const RULES = {
  install: `Install the CLI if it is missing: \`npm i -g ${PKG}\``,

  wait:
    `Always pass \`--wait\`. Without it the command returns as soon as the address is ` +
    `reserved and finishes building after you have stopped watching, so you would report ` +
    `success for a build that has not happened.`,

  green:
    `It worked only when you see a line beginning \`✓ live:\`. Getting it green is your ` +
    `job, not the user's: \`${CLI} logs <app>\` shows what production actually saw, ` +
    `\`${CLI} errors <app>\` shows what is failing now, and \`${CLI} diagnose <app>\` hands ` +
    `you a fix. Fix the code, deploy again, repeat. Do not paste an error back and ask what to do.`,

  injected:
    `Never set \`DATABASE_URL\`, \`REDIS_URL\` or \`STORAGE_BUCKET\`. ${BRAND} provisions ` +
    `those and injects them, so a value you set will be wrong.`,

  dotenv:
    `The project's \`.env\` travels with the deploy, so do not copy keys across by hand. ` +
    `Use \`${CLI} env <app> set KEY=VALUE\` only for a value that is not already in it.`,

  secrets:
    `If a key is missing or is obviously a placeholder (\`sk_test_…\`, \`changeme\`), ask ` +
    `for the real one in one sentence: what it is and where to get it. Never invent, ` +
    `hardcode, commit, or print a secret value.`,

  plain: `Keep the user posted in plain language; they do not read build logs.`,

  private:
    `Every app is private until its owner says otherwise, so an address that asks them to ` +
    `sign in is not a bug. Tell them it is live and private, and that they can open it up later.`,

  disk: `Anything written outside \`/data\` does not survive a redeploy. \`/data\` is the persistent disk.`,
} as const;

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
    `   ${CLI} deploy --wait`,
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
