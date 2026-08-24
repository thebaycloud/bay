import { productName } from "./brand";
import { rules } from "./prompt-rules";

/**
 * The prompts this app hands to a coding agent.
 *
 * The shared sentences come from packages/prompts/rules.ts, copied into
 * lib/prompt-rules.ts by scripts/sync-prompt-rules.mjs. apps/landing composes
 * its prompts from the same text, so the `✓ live:` criterion, the secrets line
 * and the DATABASE_URL warning cannot drift between the dashboard and the
 * marketing site. Run the script with `--check` to prove it.
 *
 * ON VOICE. These rules are third person ("the user", "its owner") because the
 * same sentences are also spent in documents an agent reads ABOUT a user:
 * llms.txt, selfhost.md, and the per-template agent.md. This app's prompt used
 * to be first person throughout ("my app", "keep me posted"), which is warmer
 * for something a person copies and pastes. Sharing one string across both
 * audiences costs that warmth, and the trade is deliberate: one wording that is
 * slightly formal beats five wordings that disagree about what success means.
 * The framing sentences around the rules stay first person.
 */

/**
 * The command and the package that provides it.
 *
 * Not in lib/brand.ts because that module is about what the product is CALLED
 * and this is about what you type. `pkg` is NOT `cli`: a name can be taken on
 * npm and free as a binary, and defaulting one to the other is how every prompt
 * on the marketing site came to say `npm i -g bay`, which installs an unrelated
 * published package and leaves the agent with no binary and a zero exit code.
 */
const CLI = "bay";
const PKG = "@thebaycloud/cli";

export const RULES = rules({ brand: productName(), cli: CLI, pkg: PKG });

/**
 * What the "ship with your agent" prompt puts on the clipboard.
 *
 * Longer than the marketing site's because it is read by someone who already has
 * an account and a specific app in mind, so it carries the two things only this
 * surface knows to warn about: migrations that nothing in the repo explains how
 * to run, and how to make the app public afterwards.
 */
export function agentPrompt(): string {
  const brand = productName();
  return [
    `You are publishing my app to ${brand}, a cloud for small software. The manual is at ` +
      `https://thebay.cloud (curl it). Run everything from my project's root folder. ` +
      `${RULES.plain}`,
    ``,
    `1. ${RULES.install}`,
    ``,
    `2. Publish it, and WAIT for the answer:`,
    `   ${CLI} ship --wait`,
    `   The first run opens a browser for me to sign in. ${RULES.wait}`,
    ``,
    `3. ${RULES.green}`,
    ``,
    `4. ${RULES.private} \`${CLI} share <app> public\` opens it to anyone with the link.`,
    ``,
    `${RULES.dotenv} ${RULES.injected}`,
    ``,
    `If my app has migrations and nothing in the repo says how to run them, meaning no ` +
      `Procfile release line and nothing in compose.yml, fly.toml or package.json, say so and ` +
      `add one. An app shipped against an empty schema serves its homepage and fails ` +
      `everything else.`,
    ``,
    `${RULES.secrets}`,
  ].join("\n");
}

/**
 * NOT here: the Ship new dialog's prompt (components/ShipNew.tsx).
 *
 * It keeps its own two-line paraphrase of the --wait rule on purpose. That
 * surface is a button with a prompt beside it and the long version lives at
 * /new, so composing it from RULES.wait would make it three times longer to
 * remove a duplication nobody can act on wrongly. Sharing a sentence is only
 * worth it where both copies want to say the same amount.
 */
