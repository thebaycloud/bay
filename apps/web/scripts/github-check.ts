/**
 * The chain, end to end, against the real GitHub App.
 *
 * The unit tests cover our decisions and deliberately do not cover this: that
 * GitHub honours any of them. Every link is asked separately so a break names
 * itself — an App that cannot sign, an installation that is gone, a repository
 * selection that was narrowed, a clone that is refused.
 *
 * Run it after a credential rotation, after a re-install, and any time a deploy
 * from a private repository fails in a way nobody can explain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import { installationToken, appJwt, githubAppConfigured } from "../lib/github-app";
import { listRepos, authenticatedCloneUrl } from "../lib/github-repos";
import { redactToken } from "../lib/github-clone";

// The same loader the app uses, so a key that works in `next dev` works here
// and settles its newlines identically. A check that read the PEM its own way
// could pass while the app fails, or the reverse — the one thing this script
// must never do.
//
// This runs AFTER every import above, because that is what ESM does regardless
// of where the call is written. It works because lib/github-app reads the
// environment inside its functions rather than at module load; moving that to a
// top-level const would break this script and nothing else, silently.
loadEnvConfig(process.cwd(), true);

async function main() {
  if (!githubAppConfigured()) {
    throw new Error("GH_APP_ID / GH_APP_PRIVATE_KEY are not set — check .env.local, or the Cloud Run mounts");
  }
  console.log(`app id: ${process.env.GH_APP_ID}`);

  const res = await fetch("https://api.github.com/app/installations", {
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "supersonic",
    },
  });
  if (!res.ok) {
    // The one failure that is ours rather than anybody's configuration.
    throw new Error(`listing installations: ${res.status} ${await res.text()} — the private key does not match this app id`);
  }
  const installs = (await res.json()) as Array<{ id: number; account: { login: string } }>;
  console.log(`installations: ${installs.length}`);
  if (!installs.length) throw new Error("the App is installed nowhere — install it on an account first");

  for (const i of installs) {
    console.log(`\n${i.account.login} (installation ${i.id})`);
    const token = await installationToken(i.id);
    console.log(`  token: minted, expires within the hour`);
    const repos = await listRepos(i.id);
    console.log(`  repositories: ${repos.length}`);
    // A private one when there is one: a public repository clones with no
    // credential at all, so cloning one proves nothing about the token.
    const target = repos.find((r) => r.private) ?? repos[0];
    if (!target) {
      console.log("  nothing to clone — this installation was given no repositories");
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), "ghcheck-"));
    try {
      execFileSync("git", [
        "clone", "--depth", "1",
        authenticatedCloneUrl(`https://github.com/${target.fullName}.git`, token),
        dir,
      ], { stdio: "pipe" });
      console.log(`  clone of ${target.fullName}${target.private ? " (private)" : " (public)"}: ok`);
    } catch (e) {
      throw new Error(redactToken(`cloning ${target.fullName}: ${e instanceof Error ? e.message : String(e)}`, token));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log("\nthe chain works end to end");
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
