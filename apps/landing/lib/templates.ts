import { BRAND, CLI, DOMAIN, PKG, SITE } from "./brand";

/**
 * Self-host templates, as data.
 *
 * One record per template, read by three consumers: the index page, the detail
 * page, and `/templates/<slug>/agent.md`. That last one is the important
 * consumer — it is what an agent actually follows, and the human page is a
 * rendering of the same record. A template that is data cannot promise on the
 * page something the instructions do not do, which is the failure this repo has
 * already had twice (MCP, "Backups and undo").
 *
 * There is no hosted wizard and no `?template=` endpoint on purpose. The first
 * step of signing up is handing a prompt to your agent: the agent clones
 * upstream, runs `${CLI} deploy`, and the CLI's first run opens a browser to
 * sign in. The dashboard is not on the path.
 *
 * What every template can rely on, verified against the pipeline rather than
 * assumed:
 *   - A repo's own Dockerfile is used, and its build context is read from it
 *     (apps/web/lib/dockerfile-context.ts). Everything builds from source; there
 *     is no deploy-this-prebuilt-image path.
 *   - DATABASE_URL, REDIS_URL and STORAGE_BUCKET are injected when provisioned.
 *   - A persistent disk is bind-mounted at /data (services/fleet/agent/container.go).
 *   - `release` is a real process type and runs before `web`, which is where
 *     migrations belong.
 *   - The address is reserved BEFORE the build finishes, so an app that needs to
 *     know its own URL can be told it.
 *   - Every app is private until its owner says otherwise.
 */

export interface Template {
  slug: string;
  name: string;
  /** File in public/logos/brand, without the extension. */
  logo: string;
  /** Height in px for the logo lockup. Set per mark; see the home page strip. */
  logoHeight: number;
  /** Card screenshot in public/templates. 720x450, the source's own matte
   *  trimmed off first so three cards crop to the same optical weight. */
  shot: string;
  /** One line, for the card. */
  blurb: string;
  /** What it is, for the detail page. */
  what: string;
  repo: string;
  /** What Bay stands up for it. */
  provisions: string[];
  /** Secrets that are just entropy, so the agent makes them rather than asking. */
  generates: string[];
  /** Env that must be the app's own address, which Bay knows before the build. */
  selfUrl: string[];
  /** The only things a person can be asked for. */
  asks: { key: string; what: string; required: boolean }[];
  /** True when migrations have to run before web starts. */
  needsRelease: boolean;
  /** Anything a reader should know before they click. */
  caveats: string[];
  /** The body of agent.md, after the shared preamble. */
  steps: string[];
}

export const TEMPLATES: Template[] = [
  {
    slug: "excalidraw",
    shot: "/templates/excalidraw.webp",
    name: "Excalidraw",
    logo: "excalidraw",
    logoHeight: 30,
    blurb: "The whiteboard, running on an address of your own.",
    what: "A virtual whiteboard for sketching hand-drawn diagrams. It builds to static files and keeps its scenes in the browser, so there is nothing to provision and nothing to configure.",
    repo: "https://github.com/excalidraw/excalidraw",
    provisions: [],
    generates: [],
    selfUrl: [],
    asks: [],
    needsRelease: false,
    caveats: [
      "Scenes live in the browser, not on the server. This is the drawing tool, not a shared workspace with accounts.",
    ],
    steps: [
      `Clone the repo and work inside it: \`git clone ${"https://github.com/excalidraw/excalidraw"} && cd excalidraw\``,
      `Run \`${CLI} deploy --wait\`. There is nothing to configure: no database, no secrets, no environment variables.`,
      `It worked only when you see a line beginning \`✓ live:\`. If the build fails, \`${CLI} logs <app>\` shows what the build actually saw and \`${CLI} diagnose <app>\` hands you a fix. Fix it and deploy again.`,
      `Tell me the address, and tell me it is private until I say otherwise.`,
    ],
  },
  {
    slug: "open-webui",
    shot: "/templates/open-webui.webp",
    name: "Open WebUI",
    logo: "openwebui",
    logoHeight: 24,
    blurb: "A private chat interface for your own models.",
    what: "A self-hosted interface for local and API models. It stores conversations in Postgres and its uploads on disk, both of which Bay provides, so it comes up usable with no keys at all.",
    repo: "https://github.com/open-webui/open-webui",
    provisions: ["Postgres", "A persistent disk at /data"],
    generates: ["WEBUI_SECRET_KEY"],
    selfUrl: [],
    asks: [
      {
        key: "OPENAI_API_KEY",
        what: "Only if you want to talk to OpenAI-compatible models. Skip it and point it at Ollama later, or add it any time with `bay env`.",
        required: false,
      },
    ],
    needsRelease: false,
    caveats: [
      "The first account created becomes the administrator. On Bay the app is private anyway, so that account is yours.",
      "With no model provider configured it starts and runs, it just has nothing to talk to yet.",
    ],
    steps: [
      `Clone the repo and work inside it: \`git clone ${"https://github.com/open-webui/open-webui"} && cd open-webui\``,
      `Run \`${CLI} deploy --wait\`. Bay reads the repo's own Dockerfile, provisions Postgres, and injects \`DATABASE_URL\`.`,
      `Generate a random 48-character secret yourself and set it: \`${CLI} env <app> set WEBUI_SECRET_KEY=<random>\`. Do not ask me for this and do not print it. It is entropy, not a credential I hold.`,
      `Point its writable state at the persistent disk: \`${CLI} env <app> set DATA_DIR=/data\`. Anything written outside /data does not survive a redeploy.`,
      `Deploy again so the new environment is picked up, and wait for \`✓ live:\`.`,
      `Do NOT set a model provider unless I gave you a key. If I did, set \`OPENAI_API_KEY\`. If I did not, tell me the app is up and that I can add a provider later, or point it at an Ollama endpoint.`,
      `Tell me the address, and tell me the first account I create becomes the admin.`,
    ],
  },
  {
    slug: "cal-com",
    shot: "/templates/cal-com.webp",
    name: "Cal.com",
    logo: "calcom",
    logoHeight: 22,
    blurb: "Scheduling you own, on your own domain.",
    what: "Open-source scheduling. It needs Postgres, a couple of generated secrets, its own address in its environment, and its migrations run before the web process starts. All four are things Bay can do without asking you anything.",
    repo: "https://github.com/calcom/cal.com",
    provisions: ["Postgres"],
    generates: ["NEXTAUTH_SECRET", "CALENDSO_ENCRYPTION_KEY"],
    selfUrl: ["NEXT_PUBLIC_WEBAPP_URL", "NEXTAUTH_URL"],
    asks: [
      {
        key: "Google OAuth client",
        what: "Only if you want to connect Google Calendar. Cal.com runs without it; the calendar integrations are what stay switched off.",
        required: false,
      },
    ],
    needsRelease: true,
    caveats: [
      "This is a monorepo and the Docker build is long. On the free plan you get 30 builds a month and one at a time, so a couple of failed attempts is a real dent.",
      "Its migrations must run before the web process starts. That is what the release step is for, and skipping it gives you an app that serves its homepage and fails everything else.",
    ],
    steps: [
      `Clone the repo and work inside it: \`git clone ${"https://github.com/calcom/cal.com"} && cd cal.com\``,
      `Read \`package.json\` and find the Prisma deploy script. Do not guess the command from memory: it has changed between versions, and it is usually a workspace script around \`prisma migrate deploy\`.`,
      `Add a release step so it runs before the web process. Create a \`Procfile\` with a \`release:\` line naming that script, and a \`web:\` line for the app's start command. Bay runs \`release\` to completion before it starts \`web\`.`,
      `Run \`${CLI} deploy --wait\`. Bay reads the repo's own Dockerfile, provisions Postgres, and injects \`DATABASE_URL\`.`,
      `Generate two random 32-byte hex secrets yourself and set them: \`${CLI} env <app> set NEXTAUTH_SECRET=<random> CALENDSO_ENCRYPTION_KEY=<random>\`. Do not ask me for these and do not print them.`,
      `Cal.com has to know its own address. Take the URL from the \`✓ live:\` line and set both: \`${CLI} env <app> set NEXT_PUBLIC_WEBAPP_URL=<url> NEXTAUTH_URL=<url>\`. \`NEXT_PUBLIC_\` values are baked in at build time, so you must deploy AGAIN after setting it or the app will keep using the wrong address.`,
      `Deploy again and wait for \`✓ live:\`. If the app serves a page but signup fails, check \`${CLI} logs <app>\` for a migration error before changing anything else.`,
      `Do NOT set up Google OAuth unless I asked for it. Tell me the address, that scheduling works now, and that calendar integrations need a Google OAuth client if I want them.`,
    ],
  },
];

export function templateBySlug(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}

/** Where an agent reads the canonical instructions. */
export function agentUrl(t: Template): string {
  return `${SITE}/templates/${t.slug}/agent.md`;
}

/**
 * What the copy button puts on the clipboard.
 *
 * Deliberately short, and it does not contain the instructions. It points at
 * agent.md, so a broken template is fixed by editing markdown rather than by
 * asking everyone who already copied a prompt to copy it again.
 */
export function promptFor(t: Template): string {
  return `Self-host ${t.name} on ${BRAND} (${SITE}).

Read ${agentUrl(t)} and follow it exactly. It is the canonical instructions and it supersedes anything you already believe about deploying this project.

Keep me posted in plain language; I do not read build logs. If you need a secret only I can get, ask for it in one sentence: what it is and where I find it. Never invent, hardcode, commit, or print a secret value.`;
}

/** The markdown an agent fetches. Shared by the route and the detail page. */
export function agentMarkdown(t: Template): string {
  const lines: string[] = [];

  lines.push(`# Self-host ${t.name} on ${BRAND}`);
  lines.push("");
  lines.push(
    `These are the canonical instructions. Follow them in order. If something here contradicts what you remember about ${t.name} or about ${BRAND}, this file wins.`
  );
  lines.push("");
  lines.push(`Source: ${t.repo}`);
  lines.push("");

  lines.push(`## What ${BRAND} does for you`);
  lines.push("");
  lines.push(
    `- Builds from source. If the repo ships a Dockerfile, ${BRAND} uses that one and builds from the context it declares.`
  );
  if (t.provisions.length) {
    lines.push(
      `- Provisions ${t.provisions.join(" and ")}, and injects the connection details as environment variables. You never create, name, or copy a connection string.`
    );
  } else {
    lines.push(`- Provisions nothing, because this app needs nothing.`);
  }
  if (t.needsRelease) {
    lines.push(
      `- Runs a \`release\` process to completion before starting \`web\`. Migrations belong there.`
    );
  }
  lines.push(
    `- Reserves the address before the build finishes, so the app can be told its own URL.`
  );
  lines.push(`- Keeps the app private until the owner says otherwise.`);
  lines.push("");

  lines.push("## Before you start");
  lines.push("");
  lines.push(`Install the CLI if it is missing: \`npm i -g ${PKG}\``);
  lines.push("");
  lines.push(
    `Always pass \`--wait\`. Without it the command returns as soon as the address is reserved and finishes building after you have stopped watching, so you would report success for a build that has not happened.`
  );
  lines.push("");
  lines.push(
    `The deploy worked only when you see a line beginning \`✓ live:\`. Anything else is not done. Getting it green is your job: \`${CLI} logs <app>\` shows what production actually saw, \`${CLI} errors <app>\` shows what is failing now, and \`${CLI} diagnose <app>\` hands you a fix. Fix, deploy, repeat. Do not paste an error back to the user and ask what to do.`
  );
  lines.push("");

  lines.push("## Steps");
  lines.push("");
  t.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");

  if (t.generates.length) {
    lines.push("## Secrets you generate, not ask for");
    lines.push("");
    lines.push(
      `${t.generates.map((g) => `\`${g}\``).join(", ")} — these are random strings. Generate them yourself, set them with \`${CLI} env\`, and never print them. Asking a person to invent entropy is what makes self-hosting feel like work.`
    );
    lines.push("");
  }

  const required = t.asks.filter((a) => a.required);
  lines.push("## What you may ask the user for");
  lines.push("");
  if (!t.asks.length) {
    lines.push("Nothing. Do not ask any questions. Deploy it.");
  } else {
    if (!required.length) {
      lines.push(
        `Nothing is required. The app comes up without any of the following, so deploy first and mention these afterwards.`
      );
      lines.push("");
    }
    for (const a of t.asks) {
      lines.push(`- \`${a.key}\` (${a.required ? "required" : "optional"}): ${a.what}`);
    }
  }
  lines.push("");

  lines.push("## Rules");
  lines.push("");
  lines.push(
    `- The app's \`.env\` travels with the deploy. Do not copy keys across by hand. Use \`${CLI} env <app> set KEY=VALUE\` only for a value that is not already in it.`
  );
  lines.push(
    `- Never set \`DATABASE_URL\`, \`REDIS_URL\` or \`STORAGE_BUCKET\`. ${BRAND} provisions those and injects them; a value you set will be wrong.`
  );
  lines.push(
    `- Anything written outside \`/data\` does not survive a redeploy. \`/data\` is the persistent disk.`
  );
  lines.push(
    `- If a key is missing or is obviously a placeholder (\`sk_test_…\`, \`changeme\`), ask for the real one in one sentence. Never invent, hardcode, commit, or print a secret value.`
  );
  lines.push("");

  if (t.caveats.length) {
    lines.push("## Tell the user these");
    lines.push("");
    for (const c of t.caveats) lines.push(`- ${c}`);
    lines.push("");
  }

  lines.push(`Full command reference: ${SITE}/llms.txt`);
  lines.push("");

  return lines.join("\n");
}

// ── self-hosting anything ──────────────────────────────────────────────────

// The templates are three on-ramps, not the whole offer: the free year applies
// to any public repo under an OSI licence, so the landing page needs a path that
// does not depend on us having listed the thing someone wants. This is that
// path. The agent asks which project; there is no list to be on.

export const SELFHOST_DOC = `${SITE}/selfhost.md`;

export function selfhostPrompt(): string {
  return `I want to self-host an open source project on ${BRAND} (${SITE}).

Ask me which project, then read ${SELFHOST_DOC} and follow it exactly.

Keep me posted in plain language; I do not read build logs. If you need a secret only I can get, ask for it in one sentence: what it is and where I find it. Never invent, hardcode, commit, or print a secret value.`;
}

/** The generic instructions, for any project rather than a listed one. */
export function selfhostMarkdown(): string {
  return [
    `# Self-host any open source project on ${BRAND}`,
    "",
    `These are the canonical instructions. If something here contradicts what you remember about ${BRAND}, this file wins.`,
    "",
    "## First, ask",
    "",
    "Ask which project they want to run, and get a repo URL. Do not guess and do not pick one for them.",
    "",
    `Then look at the repo before you start. If it needs more than one service to run (a separate search engine, a separate ML worker, its own message broker) say so plainly and stop: ${BRAND} runs ONE app with \`web\`, \`worker\`, \`cron\` and \`release\` processes from a single image. If it needs MySQL, say so: ${BRAND} provisions Postgres.`,
    "",
    `## What ${BRAND} does for you`,
    "",
    "- Builds from source. If the repo ships a Dockerfile, that one is used, from the context it declares.",
    "- Provisions Postgres, Redis and object storage on request, and injects `DATABASE_URL`, `REDIS_URL` and `STORAGE_BUCKET`. Never set those yourself; a value you set will be wrong.",
    "- Bind-mounts a persistent disk at `/data`. Anything written outside it does not survive a redeploy.",
    "- Runs `release` to completion before starting `web`, which is where migrations belong.",
    "- Reserves the address before the build finishes, so an app that needs to know its own URL can be told it.",
    "- Keeps every app private until its owner says otherwise.",
    "",
    "## Steps",
    "",
    `1. Install the CLI if it is missing: \`npm i -g ${PKG}\``,
    "2. Clone the repo they named and work inside it. Keep the git remote intact: it is how the open source year is detected.",
    `3. Read the project's own docs for its required environment. Generate anything that is only entropy (session secrets, encryption keys) yourself and set it with \`${CLI} env <app> set KEY=VALUE\`. Do not ask a person to invent a random string.`,
    `4. If it needs migrations, add a \`Procfile\` with a \`release:\` line for them and a \`web:\` line for the start command.`,
    `5. Run \`${CLI} deploy --wait\`. Always \`--wait\`: without it the command returns as soon as the address is reserved and finishes building after you have stopped watching.`,
    `6. If the app needs its own URL in its environment, take it from the \`✓ live:\` line, set it, and deploy AGAIN. Values baked in at build time do not update without a rebuild.`,
    `7. It worked only when you see \`✓ live:\`. Otherwise: \`${CLI} logs <app>\` for what production saw, \`${CLI} errors <app>\` for what is failing, \`${CLI} diagnose <app>\` for a fix. Fix, deploy, repeat. Do not paste an error back and ask what to do.`,
    "",
    "## The free year",
    "",
    "Nothing to claim and nothing to ask for. A public repo under an OSI-approved licence is detected at deploy from the git remote and the commit history, and the first year is free. Leave the remote alone and it happens by itself.",
    "",
    "## Then tell them",
    "",
    "The address, that the app is private until they say otherwise, and anything they still have to supply themselves (an OAuth client, an SMTP host, an API key).",
    "",
    `Full command reference: ${SITE}/llms.txt`,
    "",
  ].join("\n");
}
