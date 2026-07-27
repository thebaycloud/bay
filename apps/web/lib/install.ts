/**
 * A reproducible install that falls back to a working one.
 *
 * `npm ci` refuses to run when package.json and package-lock.json disagree, and
 * they disagree constantly in the projects we host — someone adds a dependency by
 * hand or an agent edits package.json and nobody regenerates the lock. Measured on
 * a real repository: the build failed at 37s, the repair agent worked out to run
 * `npm install`, and the deploy finished at 119s instead of about 50s. An LLM round
 * trip to rediscover a fallback a shell operator can express.
 *
 * The lockfile is still preferred when usable, so a correct project keeps its
 * reproducible install. Only the failure path changes.
 *
 * Yarn and pnpm are left alone — their frozen-lockfile modes fail loudly for
 * reasons worth surfacing, and neither has npm's habit of drifting.
 *
 * Lives here rather than in the route because a Next.js route file may only
 * export its handlers and config.
 */
export function resilientInstall(installCommand: string | null): string | null {
  if (!installCommand) return null;
  if (!/^npm ci\b/.test(installCommand)) return installCommand;
  return `${installCommand} || npm install ${installCommand.replace(/^npm ci\s*/, "")}`.trimEnd();
}
