import type { App } from "@/lib/app-row";

/**
 * Sample apps, for looking at the list without a database behind it.
 *
 * Behind an explicit `MOCK_APPS=1`, and refused outright when NODE_ENV is
 * production. Not a fallback for a failed read: a list that quietly invents rows
 * when Postgres is unreachable is a dashboard that lies at exactly the moment
 * somebody is trying to find out whether their app is fine. The real read still
 * says "your apps could not be read just now" when it cannot read them.
 *
 * The set is chosen to exercise every row state at once — live, shipping, failed,
 * a never-shipped app, and a name long enough to need truncating — because those
 * are the five shapes a row has and four of them are invisible with one real app.
 */
export function mockApps(): App[] {
  const min = 60_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  return [
    {
      slug: "harbor",
      name: "harbor",
      url: "https://harbor.thebay.cloud",
      ready: true,
      region: "us-central1",
      image: "",
      deployedAt: ago(14 * min),
      deployMs: 41_000,
    },
    {
      slug: "echo-chamber-social",
      name: "echo-chamber-social",
      url: "https://echo-chamber-social.thebay.cloud",
      ready: true,
      region: "us-central1",
      image: "",
      deployedAt: ago(2 * 24 * 60 * min),
      deployMs: 58_000,
    },
    {
      slug: "standup-notes",
      name: "standup-notes",
      url: "https://standup-notes.thebay.cloud",
      ready: false,
      region: "us-central1",
      image: "",
      status: "building",
      stage: "building the image…",
    },
    {
      slug: "checkout-service",
      name: "checkout-service",
      url: "https://checkout-service.thebay.cloud",
      ready: false,
      region: "us-central1",
      image: "",
      status: "failed",
      deployedAt: ago(6 * 60 * min),
      error: 'relation "orders" does not exist — the setup step never ran',
    },
    {
      // Long enough to truncate, which is the only way to see that it does.
      slug: "internal-analytics-dashboard-experiment",
      name: "internal-analytics-dashboard-experiment",
      url: "https://internal-analytics-dashboard-experiment.thebay.cloud",
      ready: true,
      region: "us-central1",
      image: "",
      deployedAt: ago(9 * 24 * 60 * min),
      deployMs: 121_000,
    },
    {
      slug: "voice-router",
      name: "voice-router",
      url: "https://voice-router.thebay.cloud",
      ready: true,
      region: "us-central1",
      image: "",
      // No deployedAt: an app on file that has never finished a ship. The row
      // shows an em dash rather than inventing "just now".
    },
  ];
}
