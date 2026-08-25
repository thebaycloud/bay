/**
 * English, and the shape every other catalogue must satisfy.
 *
 * Authored from the pages rather than generated, so this file is the source and
 * the pages read from it. `lib/i18n/types.ts` derives the Messages type from
 * this object: add a key here and the five translations stop compiling until
 * they have it too, which is the point.
 *
 * WHAT IS NOT IN HERE, on purpose:
 *   - Brand and product names. They are constants in lib/brand.ts and arrive
 *     through {brand}, {domain} and {cli} placeholders, so cutover day is still
 *     one edit and not six.
 *   - Anything set in mono: CLI commands, env var names, simulated terminal
 *     output, log lines. The product speaks English at the command line and a
 *     half-translated terminal is worse than an English one.
 *   - The agent prompts and llms.txt. Those are read by coding agents and
 *     contain commands copied verbatim. A translated prompt is a broken prompt.
 *   - The changelog. Entries are dated and grow without end, and every future
 *     post would owe five translations before it could ship.
 */
const en = {
  nav: {
    product: "Product",
    ship: "Ship",
    services: "Services",
    fixes: "Fixes",
    agents: "Agents",
    templates: "Templates",
    pricing: "Pricing",
    resources: "Resources",
    changelog: "Changelog",
    docs: "Docs",
    community: "Community",
    myApps: "My apps",
    homeAria: "{brand} home",
  },

  hero: {
    h1: "The cloud for the agentic era",
    p: "{brand} runs the apps you build with coding agents. Deploy from your agent or terminal with a live URL, Postgres, Redis and storage included.",
  },

  // The hero and closing button. It copies a prompt rather than navigating.
  onboard: {
    label: "Onboard your agent",
    copied: "Copied. Paste it to your agent.",
    aria: "Copy the prompt that onboards your coding agent",
  },

  intro: {
    h2: "Every app ships from the bay",
    // The heading is the metaphor; this stays literal and borrows only the words
    // that are the plain ones anyway. "Leaves port" and "keep watch" both mean
    // exactly what they say here, which is the line between a storyline and a
    // riddle.
    p: "Nothing to set up. Every app leaves port with a live address and a database backed up from the first deploy. We keep watch after that, and tell you what broke in plain words.",
    link: "Onboard your agent",
  },

  worksWith: {
    line: "Works with the coding agent you already have open",
  },

  features: {
    h2: "Your app needs more than a server",
    cta: "Ship your app",
    ship: {
      h: "Ship it with one command",
      p: "{brand} builds the app and gives back a live URL. Next, Django, Rails, Go, or anything in a container.",
    },
    services: {
      h: "Builds every service",
      p: "Postgres, Redis and object storage come up with your app. Workers and cron run beside it. You provision none of it.",
    },
    fixes: {
      h: "Hands your agent bug fixes",
      p: "{brand} catches errors in production and turns them into an instruction for your coding agent.",
    },
  },


  interfaces: {
    h2: "MCP and CLI instead of a dashboard",
    cli: {
      title: "Command line",
      p: "Anything that can run a command can run your infrastructure",
      pmAria: "Package manager",
      copyAria: "Copy command",
      copiedAria: "Copied",
    },
    // Keyed by the command itself, which is not translated.
    commands: {
      ship: "ship the folder you are in",
      logs: "what production actually saw",
      errors: "what is failing right now",
      diagnose: "a fix your agent can act on",
      rollback: "back to a version that worked",
      env: "secrets, never in the code",
      exec: "a shell on the live app",
    },
    mcp: {
      // Not built yet, and labelled rather than implied.
      soon: "Soon",
      p: "Your agent calls {brand} as tools instead of shelling out. Deploy, read the logs and apply a fix, all without leaving the editor it is already in.",
      cta: "Read the agent manual",
    },
  },

  templatesSection: {
    h2: "Self-host something you already use",
    all: "All templates",
    cardCta: "Self-host it",
    shotAlt: "{name} running",
  },

  oss: {
    h2: "Self-hosting is free for 1 year",
    p: "We love open source, and we want software to be easier for anyone to run.",
    cta: "Self-host anything",
  },

  closing: {
    h2: "Bring it in to the bay",
  },

  footer: {
    tagline: "The cloud for the agentic era",
    product: "Product",
    whatYouGet: "What you get",
    pricing: "Pricing",
    build: "Build",
    agentManual: "Agent manual",
    shipAnApp: "Ship an app",
    signIn: "Sign in",
    company: "Company",
    contact: "Contact",
    github: "GitHub",
    // The company name is a legal entity and is not translated.
    rights: "© {year} Supersonic Software, Inc.",
    languageAria: "Language",
    rss: "RSS",
  },

  pricing: {
    metaTitle: "Pricing",
    metaDescription: "Free forever, and no infrastructure bill.",
    h1: "Free forever. No infrastructure bill.",
    p: "Your cloud is included and you never see an AWS invoice. Apps on the free plan never sleep or expire.",
    // Renders as "$20 / per month".
    per: "/",
    footnote:
      "Self-hosting an open source project is free for its first year on top of any of these. Nothing to claim: it is detected when you deploy.",
    plans: {
      free: {
        name: "Free",
        unit: "forever",
        desc: "Three real apps with a database, an address, and everyone you share them with.",
        rows: [
          "3 apps",
          "Database and storage included",
          "Share with anyone by email",
          "One public app",
        ],
        cta: "Start free",
      },
      pro: {
        name: "Pro",
        unit: "per month",
        desc: "Unlimited apps, a domain of your own, and failed deploys that repair themselves.",
        rows: [
          "Everything in Free, unlimited",
          "Your own domain",
          "Auto-fix every failed build",
          "No {brand} badge",
          "Backups and undo",
        ],
        cta: "Go Pro",
      },
      team: {
        name: "Team",
        // A worded price, not a numeral. It is set smaller than $20 on purpose.
        price: "Let's talk",
        unit: "",
        desc: "For a team whose internal tools all live in one place. You pay for the people who build, never for the people who use.",
        rows: [
          "Everything in Pro",
          "Sign in with your company domain",
          "Roles and an audit log",
          "Unlimited recipients, always free",
        ],
        cta: "Talk to us",
      },
    },
  },

  templatesPage: {
    metaTitle: "Self-host templates",
    metaDescription:
      "Open source you already use, running on an address of your own. Hand the prompt to your coding agent and it does the rest.",
    h1: "Self-host something you already use",
    p: "Your own address, your own database, your own copy. You do not click through a setup wizard: you hand a prompt to the coding agent you already have open, and it deploys the thing while you read something else.",
    footnote:
      "Every one of these builds from its own source on your account. {brand} provisions what it needs, generates the secrets that are only entropy, and asks you for nothing that it can work out itself.",
  },

  templatePage: {
    metaTitle: "Self-host {name}",
    h1: "Self-host {name}",
    copyLabel: "Onboard your agent",
    copyNote:
      "Paste it into Claude Code, Codex, Cursor or anything else that runs commands. It clones the source, deploys it, and signs you in on the way past. There is no dashboard step.",
    provisionsHead: "What {brand} provisions",
    generatesHead: "Secrets it generates for you",
    asksHead: "What you may be asked for",
    handledHead: "Also handled",
    caveatsHead: "Before you start",
    noAsks: "Nothing. There is no question to answer.",
    noProvisions: "Nothing. This app needs nothing.",
    noGenerates: "None needed.",
    generatedSuffix: "{key}, generated rather than asked for",
    selfUrlLine: "Its own address, injected as {vars}",
    migrationsLine: "Migrations, run before the app starts",
    privateLine: "Private until you say otherwise",
    required: "required",
    optional: "optional",
    readInstructions: "The instructions your agent will read",
    onGithub: "{name} on GitHub",
    everyCommand: "Every {cli} command",
  },

  // The human prose from lib/templates.ts, keyed by slug. The `steps` in that
  // file are agent instructions and are not here: they stay English.
  templates: {
    excalidraw: {
      blurb: "The whiteboard, running on an address of your own.",
      what: "A virtual whiteboard for sketching hand-drawn diagrams. It builds to static files and keeps its scenes in the browser, so there is nothing to provision and nothing to configure.",
      provisions: [] as string[],
      asks: [] as string[],
      caveats: [
        "Scenes live in the browser, not on the server. This is the drawing tool, not a shared workspace with accounts.",
      ],
    },
    "open-webui": {
      blurb: "A private chat interface for your own models.",
      what: "A self-hosted interface for local and API models. It stores conversations in Postgres and its uploads on disk, both of which {brand} provides, so it comes up usable with no keys at all.",
      provisions: ["Postgres", "A persistent disk at /data"],
      asks: [
        "Only if you want to talk to OpenAI-compatible models. Skip it and point it at Ollama later, or add it any time with `{cli} env`.",
      ],
      caveats: [
        "The first account created becomes the administrator. On {brand} the app is private anyway, so that account is yours.",
        "With no model provider configured it starts and runs, it just has nothing to talk to yet.",
      ],
    },
    "cal-com": {
      blurb: "Scheduling you own, on your own domain.",
      what: "Open-source scheduling. It needs Postgres, a couple of generated secrets, its own address in its environment, and its migrations run before the web process starts. All four are things {brand} can do without asking you anything.",
      provisions: ["Postgres"],
      asks: [
        "Only if you want to connect Google Calendar. Cal.com runs without it; the calendar integrations are what stay switched off.",
      ],
      caveats: [
        "This is a monorepo and the Docker build is long. On the free plan you get 30 builds a month and one at a time, so a couple of failed attempts is a real dent.",
        "Its migrations must run before the web process starts. That is what the release step is for, and skipping it gives you an app that serves its homepage and fails everything else.",
      ],
    },
  },

  copyPrompt: {
    label: "Copy the prompt",
    copied: "Copied. Paste it to your agent.",
    aria: "Copy the prompt that tells your agent to deploy this",
  },
};

export default en;
