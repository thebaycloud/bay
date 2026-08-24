// GENERATED FILE. Do not edit.
//
// Source: packages/prompts/rules.ts
// Regenerate: node scripts/sync-prompt-rules.mjs
//
// A copy rather than an import because this app is built from its own directory
// as the Docker context, so a path outside it does not exist at build time. See
// the script for the full reasoning. `--check` keeps the copies honest.

/**
 * The sentences every prompt and agent document in this repo restates.
 *
 * THIS FILE IS THE AUTHORED SOURCE. It is copied verbatim into each app by
 * `scripts/sync-prompt-rules.mjs`, which is how two independently built and
 * independently deployed Next apps share it: `apps/landing` and `apps/web` are
 * separate npm projects with separate Docker build contexts, so neither can
 * import a path outside its own directory at build time. A committed copy inside
 * each app is the only shape that survives `gcloud run deploy --source`.
 *
 * Edit here, then run `node scripts/sync-prompt-rules.mjs`. The same script with
 * `--check` fails if a copy has drifted, which is what makes this safe.
 *
 * Zero imports, on purpose. The two apps disagree about how brand names are
 * spelled (landing exports consts, web exports `productName()`), so the names
 * arrive as arguments and this file stays portable between them.
 *
 * Why it exists: the `✓ live:` success criterion had been written out five times
 * in five slightly different wordings, the secrets line four times, the
 * DATABASE_URL warning three. A rule that lives in five files is a rule that
 * gets fixed in one of them.
 */

export interface Names {
  /** What the product is called. */
  brand: string;
  /** The command, e.g. `bay`. */
  cli: string;
  /**
   * The npm package that provides the command. NOT the same string as `cli`: a
   * name can be taken on npm and free as a binary, and defaulting one to the
   * other is exactly how every prompt on the marketing site came to say
   * `npm i -g bay`, which installs an unrelated published package and leaves the
   * agent with no binary and a zero exit code.
   */
  pkg: string;
}

export function rules({ brand, cli, pkg }: Names) {
  return {
    install: `Install the CLI if it is missing: \`npm i -g ${pkg}\``,

    wait:
      `Always pass \`--wait\`. Without it the command returns as soon as the address is ` +
      `reserved and finishes building after you have stopped watching, so you would report ` +
      `success for a build that has not happened.`,

    green:
      `It worked only when you see a line beginning \`✓ live:\`. Getting it green is your ` +
      `job, not the user's: \`${cli} logs <app>\` shows what production actually saw, ` +
      `\`${cli} errors <app>\` shows what is failing now, and \`${cli} diagnose <app>\` hands ` +
      `you a fix. Fix the code, ship again, repeat. Do not paste an error back and ask what to do.`,

    injected:
      `Never set \`DATABASE_URL\`, \`REDIS_URL\` or \`STORAGE_BUCKET\`. ${brand} provisions ` +
      `those and injects them, so a value you set will be wrong.`,

    dotenv:
      `The project's \`.env\` travels with the ship, so do not copy keys across by hand. ` +
      `Use \`${cli} env <app> set KEY=VALUE\` only for a value that is not already in it.`,

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
}

export type Rules = ReturnType<typeof rules>;
