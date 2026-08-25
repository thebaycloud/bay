/**
 * The Bay API, described.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is the surface `bay` itself speaks: every path in here is one the CLI in
 * packages/cli calls, and `test/openapi.test.ts` fails if that stops being true
 * in either direction. It is deliberately not all 55 routes under
 * apps/web/app/api — the rest answer the dashboard, Stripe, or GitHub, and
 * publishing them would describe as a contract things that are free to change
 * with the screen that uses them.
 *
 * WHY IT EXISTS
 *
 * The product's claim is that an agent operates it. An agent that can only do
 * that by shelling out to a CLI is an agent working through a keyhole: it cannot
 * discover what is possible, cannot see the shape of an answer before it asks,
 * and cannot tell a 402 it should relay from a 500 it should retry. A machine
 * -readable description is the difference between those two.
 *
 * HONESTY RULES FOR EDITING THIS FILE
 *
 * Every schema here was read off the handler, not imagined. Where a response is
 * composed at runtime — `{...account, plan, usage}` — it is described as the
 * object it is, with the keys that are certain named and the rest left open,
 * rather than invented in full. An OpenAPI document that overstates the API is
 * worse than none: it is the version an agent plans against.
 */

const DOMAIN = "thebay.cloud";
const API = `https://app.${DOMAIN}`;

/** The house error body. Every JSON error carries `error`; some add more. */
const ERROR = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string", description: "What went wrong, in a sentence meant to be shown to a person." },
    code: { type: "string", description: "Stable machine-readable identifier. Present on errors raised by the gate; older handlers carry only `error`." },
    resolution: { type: "string", description: "What to do about it." },
    documentation_url: { type: "string", format: "uri" },
    reason: { type: "string", enum: ["no_account", "app_limit", "build_limit"], description: "On 402 only: which limit was reached." },
    paywall: { type: "boolean", description: "On 402 only: the account has no plan at all." },
    upgrade: { type: "boolean", description: "On 402 only: the account has a plan and has reached its limit." },
  },
};

const err = (description) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** The three errors every authenticated endpoint can answer with. */
const COMMON = {
  401: err("No credential, or one that is not valid."),
  403: err("Authenticated, but this app belongs to somebody else."),
  500: err("Ours, not yours."),
};

const slugParam = {
  name: "slug",
  in: "path",
  required: true,
  description: "The app's name, which is also the first label of its address.",
  schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
};

const json = (description, schema) => ({
  description,
  content: { "application/json": { schema } },
});

const obj = (properties, required) => ({
  type: "object",
  ...(required ? { required } : {}),
  properties,
  additionalProperties: true,
});

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "Bay Cloud API",
    version: "1.0.0",
    summary: "Ship an app, give it a database and a domain, and read the logs when it breaks.",
    description: [
      "The API behind the `bay` CLI, and the one an agent can call directly.",
      "",
      "Every operation here needs a bearer token. `bay login` mints one and writes it to",
      "`~/.bay/config.json`; a person can also mint one at " + `https://app.${DOMAIN}/cli` + ".",
      "Send it as `Authorization: Bearer <token>`.",
      "",
      "Errors are JSON, always, including from the authentication gate. The body carries",
      "`error` as a sentence; errors raised by the gate also carry `code` and `resolution`.",
      "A 402 is not a failure to relay as one: it means a plan limit was reached, and the",
      "body says which in `reason`.",
      "",
      "Three operations stream rather than answer once: starting a deploy and following",
      "logs are `text/event-stream`, and a repair agent's patch is `text/plain`.",
    ].join("\n"),
    contact: { name: "Bay", url: `https://${DOMAIN}/contact`, email: `founders@${DOMAIN}` },
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  externalDocs: { description: "Guides and CLI reference", url: "https://bay.mintlify.app" },
  servers: [{ url: API, description: "Production" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "account", description: "Who you are, what you are entitled to, and the tokens that prove it." },
    { name: "apps", description: "The things you have shipped." },
    { name: "deploy", description: "Shipping one." },
    { name: "data", description: "The database an app was given." },
    { name: "access", description: "Who can open an app, and at which address." },
    { name: "diagnostics", description: "What production saw, and what to do about it." },
  ],
  components: {
    schemas: { Error: ERROR },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "A CLI token. `bay login`, or mint one at " + `https://app.${DOMAIN}/cli` + ".",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "authjs.session-token",
        description: "The dashboard's own session. Present so the browser client is described too; a machine should use the bearer token.",
      },
    },
  },
  paths: {
    "/api/account": {
      get: {
        tags: ["account"],
        operationId: "getAccount",
        summary: "The signed-in account, its plan, and what it has used",
        responses: {
          200: json("The account.", obj({
            email: { type: "string", format: "email" },
            name: { type: ["string", "null"] },
            plan: { type: "string", description: "free, pro, or team." },
            access: { type: "string", enum: ["active", "locked"] },
            locked: { type: "boolean" },
            usage: obj({
              apps: { type: "integer" },
              maxApps: { type: ["integer", "null"], description: "null means no limit." },
              publicApps: { type: "integer" },
              maxPublicApps: { type: ["integer", "null"] },
              builds: { type: "integer" },
              monthlyBuilds: { type: ["integer", "null"] },
              agentRuns: { type: "integer" },
              monthlyAgentRuns: { type: ["integer", "null"] },
              periodStart: { type: "string", format: "date-time" },
            }),
          })),
          401: COMMON[401],
          404: err("Signed in against an account that no longer exists."),
        },
      },
      patch: {
        tags: ["account"],
        operationId: "renameAccount",
        summary: "Change the display name",
        requestBody: {
          required: true,
          content: { "application/json": { schema: obj({ name: { type: "string" } }, ["name"]) } },
        },
        responses: {
          200: json("Renamed.", obj({ ok: { type: "boolean" }, name: { type: ["string", "null"] } })),
          400: err("`name` was not a string."),
          401: COMMON[401],
        },
      },
    },
    "/api/account/tokens": {
      get: {
        tags: ["account"],
        operationId: "listTokens",
        summary: "Every CLI token this account has minted",
        responses: {
          200: json("The tokens. The secret itself is shown once, at creation, and never here.", obj({
            tokens: { type: "array", items: obj({ id: { type: "string" }, name: { type: ["string", "null"] } }) },
          })),
          401: COMMON[401],
        },
      },
      post: {
        tags: ["account"],
        operationId: "revokeToken",
        summary: "Revoke one",
        requestBody: {
          required: true,
          content: { "application/json": { schema: obj({ revoke: { type: "string", description: "The token id." } }, ["revoke"]) } },
        },
        responses: {
          200: json("Revoked.", obj({ ok: { type: "boolean" } })),
          400: err("No token id."),
          401: COMMON[401],
          404: err("No token with that id belongs to this account."),
        },
      },
    },
    "/api/apps": {
      get: {
        tags: ["apps"],
        operationId: "listApps",
        summary: "Every app this account owns, including the ones still building",
        responses: {
          200: json("The apps.", obj({
            apps: {
              type: "array",
              items: obj({
                slug: { type: "string" },
                url: { type: "string", format: "uri" },
                region: { type: "string" },
                visibility: { type: "string", enum: ["private", "public"] },
                deployedAt: { type: ["string", "null"], format: "date-time" },
              }),
            },
          })),
          401: json(
            "Not signed in. `apps` is present and empty beside the error, so a caller that renders the list does not have to branch.",
            { allOf: [{ $ref: "#/components/schemas/Error" }, obj({ apps: { type: "array", items: {} } })] },
          ),
        },
      },
    },
    "/api/apps/{slug}": {
      parameters: [slugParam],
      get: {
        tags: ["apps"],
        operationId: "getApp",
        summary: "One app: its address, its state, and whether a deploy is running",
        responses: {
          200: json("The app.", obj({
            slug: { type: "string" },
            url: { type: "string", format: "uri" },
            repo: { type: ["string", "null"] },
            deploying: { type: "boolean" },
            stage: { type: "string", description: "Which phase a running deploy is in; empty when none is." },
          })),
          403: COMMON[403],
          404: err("No app by that name."),
        },
      },
    },
    "/api/apps/{slug}/env": {
      parameters: [slugParam],
      get: {
        tags: ["apps"],
        operationId: "listEnv",
        summary: "The names of an app's secrets — never the values",
        description: "Values are in Secret Manager and are not readable through this API by anyone, including the owner. `note` explains an empty list that is empty for a reason other than 'there are none'.",
        responses: {
          200: json("The key names.", obj({
            keys: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          })),
          403: COMMON[403],
        },
      },
      post: {
        tags: ["apps"],
        operationId: "setEnv",
        summary: "Set or unset secrets",
        description: "`set` and `unset` are alternatives, not a pair. A change reaches a running app in about ten seconds.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  set: { type: "object", additionalProperties: { type: "string" }, description: "KEY to value." },
                  unset: { type: "array", items: { type: "string" }, description: "Key names to remove." },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          200: json("Applied.", obj({ ok: { type: "boolean" }, keys: { type: "array", items: { type: "string" } }, note: { type: "string" } })),
          403: COMMON[403],
          409: err("A deploy is in flight; the change would race it."),
          500: COMMON[500],
        },
      },
    },
    "/api/apps/{slug}/domains": {
      parameters: [slugParam],
      get: {
        tags: ["access"],
        operationId: "listDomains",
        summary: "Custom domains on this app, and the DNS records they need",
        responses: {
          200: json("The domains.", obj({
            domains: { type: "array", items: obj({ hostname: { type: "string" }, status: { type: "string" } }) },
            dns: { type: "object", additionalProperties: true, description: "The records to create, ready to read out to a registrar." },
            allowed: { type: "boolean", description: "Whether this plan may attach one at all." },
            visibility: { type: "string", enum: ["private", "public"] },
          })),
          403: COMMON[403],
        },
      },
      post: {
        tags: ["access"],
        operationId: "attachDomain",
        summary: "Attach a custom domain",
        requestBody: {
          required: true,
          content: { "application/json": { schema: obj({ hostname: { type: "string" } }, ["hostname"]) } },
        },
        responses: {
          200: json("Attached. The certificate is issued asynchronously; poll this path until the domain reports active.", obj({ hostname: { type: "string" } })),
          400: err("Not a domain name, or one we refuse."),
          402: err("This plan does not include custom domains."),
          403: COMMON[403],
          409: err("Already attached, here or to another app."),
        },
      },
      delete: {
        tags: ["access"],
        operationId: "detachDomain",
        summary: "Detach one",
        parameters: [{ name: "hostname", in: "query", required: true, schema: { type: "string" } }],
        responses: { 200: json("Detached.", obj({ ok: { type: "boolean" } })), 403: COMMON[403] },
      },
    },
    "/api/apps/{slug}/share": {
      parameters: [slugParam],
      get: {
        tags: ["access"],
        operationId: "getSharing",
        summary: "Who can open this app",
        responses: { 200: json("The current grants and visibility.", obj({ visibility: { type: "string", enum: ["private", "public"] } })), 403: COMMON[403] },
      },
      post: {
        tags: ["access"],
        operationId: "setSharing",
        summary: "Make it public or private, or grant a person or a domain",
        description: "Every app is private until this says otherwise. A grant is by email address or by email domain.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  visibility: { type: "string", enum: ["private", "public"] },
                  email: { type: "string", format: "email" },
                  domain: { type: "string" },
                },
                additionalProperties: true,
              },
            },
          },
        },
        responses: {
          200: json("Applied.", obj({ ok: { type: "boolean" } })),
          400: err("Not a visibility, an address, or a domain."),
          402: err("The account has no plan, or this would pass a sharing limit."),
          403: COMMON[403],
        },
      },
    },
    "/api/apps/{slug}/errors": {
      parameters: [slugParam],
      get: {
        tags: ["diagnostics"],
        operationId: "listErrors",
        summary: "Errors production actually caught, last seven days",
        responses: {
          200: json("The errors.", obj({ errors: { type: "array", items: { type: "object", additionalProperties: true } } })),
          403: COMMON[403],
        },
      },
    },
    "/api/apps/{slug}/diagnose": {
      parameters: [slugParam],
      post: {
        tags: ["diagnostics"],
        operationId: "diagnose",
        summary: "A fix prompt, written against what actually broke",
        description: "With no body, it reads the last seven days of production errors and picks the one worth fixing. `healthy: true` means there was nothing to diagnose, which is an answer and not an error.",
        requestBody: {
          required: false,
          content: { "application/json": { schema: obj({ error: { type: "string", description: "Diagnose this instead of choosing." } }) } },
        },
        responses: {
          200: json("The diagnosis, or a clean bill of health.", {
            oneOf: [
              obj({ subject: { type: "string" }, fixPrompt: { type: "string" } }, ["subject", "fixPrompt"]),
              obj({ healthy: { type: "boolean" }, message: { type: "string" } }, ["healthy"]),
            ],
          }),
          403: COMMON[403],
          500: COMMON[500],
        },
      },
    },
    "/api/apps/{slug}/patch": {
      parameters: [slugParam],
      get: {
        tags: ["diagnostics"],
        operationId: "getPatch",
        summary: "The repair agent's diff for the last failed deploy",
        description: "A unified diff, ready for `git apply`. Not JSON: the body is the patch.",
        responses: {
          200: { description: "The diff.", content: { "text/plain": { schema: { type: "string" } } } },
          403: { description: "Not yours.", content: { "text/plain": { schema: { type: "string" } } } },
          404: { description: "The last deploy was not repaired by the agent, so there is no patch.", content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },
    "/api/apps/{slug}/logs/query": {
      parameters: [slugParam],
      get: {
        tags: ["diagnostics"],
        operationId: "queryLogs",
        summary: "A page of logs",
        parameters: [
          { name: "severity", in: "query", schema: { type: "string" }, description: "Least severe level to include." },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "since", in: "query", schema: { type: "string" }, description: "A window, e.g. `1h`." },
        ],
        responses: {
          200: json("The page, and the window it covers.", obj({
            entries: { type: "array", items: { type: "object", additionalProperties: true } },
            window: { type: "object", additionalProperties: true },
          })),
          403: COMMON[403],
          502: err("The log backend did not answer."),
        },
      },
    },
    "/api/apps/{slug}/logs/tail": {
      parameters: [slugParam],
      get: {
        tags: ["diagnostics"],
        operationId: "tailLogs",
        summary: "Follow the logs",
        description: "A stream that stays open. Read it as a stream; it does not end on its own.",
        responses: {
          200: { description: "The stream.", content: { "text/event-stream": { schema: { type: "string" } } } },
          403: { description: "Not yours.", content: { "text/plain": { schema: { type: "string" } } } },
        },
      },
    },
    "/api/apps/{slug}/db": {
      parameters: [slugParam],
      get: {
        tags: ["data"],
        operationId: "browseDatabase",
        summary: "Tables, or the rows of one",
        parameters: [
          { name: "table", in: "query", schema: { type: "string" }, description: "Omit for the table list." },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          200: json("The tables, or the rows.", { type: "object", additionalProperties: true }),
          400: err("Not a valid table name."),
          403: COMMON[403],
        },
      },
      post: {
        tags: ["data"],
        operationId: "queryDatabase",
        summary: "Run one SELECT",
        description: "Read-only and one statement, enforced server-side: anything that is not a single SELECT is refused rather than run.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: obj({ sql: { type: "string" } }, ["sql"]) } },
        },
        responses: {
          200: json("The rows.", obj({
            rows: { type: "array", items: { type: "object", additionalProperties: true } },
            fields: { type: "array", items: { type: "string" } },
          })),
          400: err("Not a SELECT, or more than one statement."),
          403: COMMON[403],
        },
      },
    },
    "/api/apps/{slug}/git": {
      parameters: [slugParam],
      get: {
        tags: ["apps"],
        operationId: "getRepoLink",
        summary: "The repository a push to which deploys this app",
        responses: {
          200: json("The link, or `connected: false`.", obj({
            connected: { type: "boolean" },
            repo: { type: "string" },
            branch: { type: "string" },
            autoDeploy: { type: "boolean" },
          }, ["connected"])),
          404: err("No app by that name, or not yours."),
        },
      },
      put: {
        tags: ["apps"],
        operationId: "setRepoLink",
        summary: "Change the branch, or turn deploy-on-push off",
        requestBody: {
          required: true,
          content: { "application/json": { schema: obj({ branch: { type: "string" }, autoDeploy: { type: "boolean" } }) } },
        },
        responses: {
          200: json("Updated.", obj({ connected: { type: "boolean" }, repo: { type: "string" }, branch: { type: "string" }, autoDeploy: { type: "boolean" } })),
          400: err("Not a branch name."),
          404: err("No app by that name, or not yours."),
          409: err("No repository is connected to this app."),
        },
      },
      delete: {
        tags: ["apps"],
        operationId: "unlinkRepo",
        summary: "Disconnect the repository",
        responses: { 200: json("Disconnected.", obj({ ok: { type: "boolean" } })), 404: err("No app by that name, or not yours.") },
      },
    },
    "/api/apps/{slug}/exec": {
      parameters: [slugParam],
      post: {
        tags: ["apps"],
        operationId: "exec",
        summary: "Run one command against a copy of the app's environment",
        requestBody: { required: true, content: { "application/json": { schema: obj({ command: { type: "string" } }, ["command"]) } } },
        responses: {
          200: json("What it printed, and what it exited with.", obj({ output: { type: "string" }, exitCode: { type: "integer" } })),
          400: err("No command."),
          403: COMMON[403],
          500: COMMON[500],
        },
      },
    },
    "/api/apps/{slug}/rollback": {
      parameters: [slugParam],
      post: {
        tags: ["apps"],
        operationId: "rollback",
        summary: "Put the previous version back in front of traffic",
        responses: { 200: json("Rolled back.", { type: "object", additionalProperties: true }), 403: COMMON[403], 500: COMMON[500] },
      },
    },
    "/api/apps/{slug}/delete": {
      parameters: [slugParam],
      post: {
        tags: ["apps"],
        operationId: "deleteApp",
        summary: "Delete the app, its images, its secrets and its database",
        description: "Irreversible.",
        responses: { 200: json("Gone.", obj({ ok: { type: "boolean" } })), 403: COMMON[403], 500: COMMON[500] },
      },
    },
    "/api/apps/{slug}/deploy-status": {
      parameters: [slugParam],
      get: {
        tags: ["deploy"],
        operationId: "getDeployStatus",
        summary: "The running or last deploy, without opening a stream",
        responses: { 200: json("The deploy, or null.", obj({ deploy: { type: ["object", "null"], additionalProperties: true } })), 403: COMMON[403] },
      },
    },
    "/api/deploy": {
      post: {
        tags: ["deploy"],
        operationId: "deploy",
        summary: "Ship, and stream the build",
        description: [
          "Answers `text/event-stream` and streams until the build ends. The reserved URL",
          "arrives early and is not the app being live; the line that says live is.",
          "",
          "Source is either a git repository by URL, or an upload prepared with",
          "/api/deploy/upload-url.",
        ].join("\n"),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: obj({
                repo: { type: "string", description: "A git URL, or the object name of a prepared upload." },
                slug: { type: "string", description: "Ship over an existing app. Omit to create one." },
                secrets: { type: "object", additionalProperties: { type: "string" } },
                run: { type: "string", description: "Override the production command. Omit and Bay decides." },
              }),
            },
          },
        },
        responses: {
          200: { description: "The build, as it happens.", content: { "text/event-stream": { schema: { type: "string" } } } },
          400: err("Malformed source reference."),
          401: COMMON[401],
          402: err("No plan, or a plan limit reached. `reason` says which."),
          503: err("The deploy could not be started."),
        },
      },
    },
    "/api/deploy/preflight": {
      post: {
        tags: ["deploy"],
        operationId: "preflight",
        summary: "Ask whether this exact source has already been shipped",
        description: "`skip: true` means the build would produce what is already live, and the answer carries the URL.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: obj({ app: { type: "string" }, hash: { type: "string", description: "A hash of the source." } }) } },
        },
        responses: {
          200: json("Whether to skip.", obj({ skip: { type: "boolean" }, slug: { type: "string" }, url: { type: "string", format: "uri" } }, ["skip"])),
          401: COMMON[401],
        },
      },
    },
    "/api/deploy/reserve": {
      post: {
        tags: ["deploy"],
        operationId: "reserve",
        summary: "Take an address before the build starts",
        description: "So that the URL can be printed immediately and answer while the build runs.",
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: {
          200: json("The reserved app.", obj({ slug: { type: "string" }, url: { type: "string", format: "uri" }, name: { type: "string" } }, ["slug", "url"])),
          401: COMMON[401],
          402: err("No plan, or a plan limit reached. `reason` says which."),
        },
      },
    },
    "/api/deploy/upload-url": {
      post: {
        tags: ["deploy"],
        operationId: "uploadUrl",
        summary: "A signed location to PUT a source archive to",
        description: "For source that is not a git URL. PUT the archive to `url`, then start the deploy naming `object`.",
        responses: {
          200: json("Where to put it.", { type: "object", additionalProperties: true }),
          401: COMMON[401],
          503: err("An upload location could not be prepared."),
        },
      },
    },
  },
};

export default spec;
