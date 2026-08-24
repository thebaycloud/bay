import { getDeploy } from "./deploys";
import { getAccount } from "./users";
import { sendEmail } from "./email";

/**
 * Telling someone their deploy finished.
 *
 * A deploy returns in about a second and then works for minutes; nobody sits
 * watching the log for the whole of it. Without this the only way to learn the
 * outcome is to go back and ask.
 *
 * WHY THIS READS THE ROW RATHER THAN BEING CALLED AT EACH ENDING
 *
 * `runDeploy` has six places that record a final status. Notifying at each of
 * them is the same mistake this codebase already documents at length — "apply
 * the plan" is implemented seven times, and a field is only as real as the
 * number of call sites that happen to read it. A seventh ending added later
 * would silently send no mail, and nothing would fail.
 *
 * So there is one hook, in a `finally`, and it reads the deploy row for the
 * truth. Whatever the pipeline recorded is what the person is told — the mail
 * and the dashboard cannot disagree, because they are the same sentence.
 */

/** The recorded end of a deploy, as the row holds it. */
export interface FinishedDeploy {
  slug: string;
  name?: string | null;
  status: string;
  url?: string | null;
  error?: string | null;
  /** Carries the "N service(s) not served" note the pipeline records. */
  stage?: string | null;
}

/**
 * Anything that must not leave our systems in a message.
 *
 * A deploy error quotes whatever the tool said, and mail is retained,
 * forwarded, and searched by people who are not the operator — a stricter place
 * than a log or a page, not a looser one.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:postgres(?:ql)?|pg|mysql|redis|mongodb(?:\+srv)?):\/\/\S+/gi, "[connection string redacted]"],
  [/\w*password\w*\s*[=:]\s*\S+/gi, "password=[redacted]"],
  [/\/cloudsql\/\S+/g, "[socket path redacted]"],
];

function redactForMail(text: string): string {
  return REDACTIONS.reduce((m, [re, with_]) => m.replace(re, with_), text);
}

/** Deploys that have ended. Anything else is still in flight. */
const FINISHED = new Set(["live", "failed"]);

/** How the pipeline records a partial success. See deploy-pipeline.ts. */
const PARTIAL = /service\(s\) not served/i;

/** Keep a quoted error readable in a mail client without losing the useful half. */
function brief(text: string, max = 600): string {
  const clean = redactForMail(text).trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * The message for a finished deploy, or null when it has not finished.
 *
 * The partial case earns its own subject deliberately. It is the failure found
 * in production on 1 Aug: the frontend is live on the app's own address, every
 * `/api` request falls through to it, and nothing anywhere is red. A mail
 * saying "your app is live" is the last place that could have been caught, and
 * it would have said it.
 */
export function deployEmail(d: FinishedDeploy): { subject: string; text: string } | null {
  if (!FINISHED.has(d.status)) return null;

  const label = d.name || d.slug;
  const address = `https://${d.slug}.supersonic.cv`;

  if (d.status === "failed") {
    const why = d.error ? brief(d.error) : "no reason was recorded, which is itself a bug — please tell us";
    return {
      subject: `✕ ${label} did not deploy`,
      text: [
        `Your deploy of ${label} (${d.slug}) failed.`,
        "",
        why,
        "",
        `Logs:  supersonic logs ${d.slug}`,
        `A fix for your repo, if the agent found one:  supersonic patch ${d.slug} | git apply`,
      ].join("\n"),
    };
  }

  const partial = d.stage && PARTIAL.test(d.stage) ? brief(d.stage) : null;
  if (partial) {
    return {
      subject: `${label} is live, but not all of it`,
      text: [
        `${label} (${d.slug}) deployed, and part of it is not being served.`,
        "",
        partial,
        "",
        `Requests to that path fall through to whatever answers "/", so the app can`,
        `look healthy while half of it is missing.`,
        "",
        `Live at:  ${address}`,
        `Logs:     supersonic logs ${d.slug}`,
      ].join("\n"),
    };
  }

  return {
    subject: `${label} is live`,
    text: [`${label} (${d.slug}) deployed.`, "", `Live at:  ${address}`].join("\n"),
  };
}

/**
 * Read the recorded outcome and tell the owner. Never throws.
 *
 * Fire-and-forget by contract: a deploy that worked must not be reported as
 * failed because a mail API was down, and one that failed must not be held open
 * while we retry a send. Same rule the thumbnail call already follows.
 */
export async function notifyDeployFinished(slug: string, ownerId: string | null | undefined): Promise<void> {
  try {
    if (!ownerId) return;
    const row = await getDeploy(slug);
    if (!row) return;
    const msg = deployEmail(row as FinishedDeploy);
    if (!msg) return;
    const account = await getAccount(ownerId);
    if (!account?.email) return;
    const sent = await sendEmail({ to: account.email, subject: msg.subject, text: msg.text });
    if (!sent.ok) console.error(`deploy mail failed for ${slug}: ${sent.error}`);
  } catch (e) {
    console.error(`deploy mail failed for ${slug}:`, e instanceof Error ? e.message : String(e));
  }
}
