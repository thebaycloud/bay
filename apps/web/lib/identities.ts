/**
 * Service accounts the platform authenticates as, in one place.
 *
 * These are here rather than next to the code that uses them because they have
 * more than one reader and `process.env` read twice is a rule with two owners:
 * set `SCHEDULER_SERVICE_ACCOUNT` for the deploy pipeline's crons and it must
 * mean the same thing for the dashboard's, or half the schedules authenticate as
 * an identity nobody granted anything to.
 *
 * The values stay env vars rather than constants because pointing a cron at a
 * dedicated, less privileged account is a permissions change and not a code one.
 */

/**
 * The identity Cloud Scheduler authenticates as when it triggers a cron.
 *
 * Defaults to the deployer, which already has `run.jobs.run` for job-backed
 * crons and — because the control plane runs as this same account, and
 * `grantInvokers` binds whatever the control plane runs as — already has
 * `run.invoker` on every sealed app for the dashboard's.
 */
export const SCHEDULER_SA = process.env.SCHEDULER_SERVICE_ACCOUNT
  ?? "supersonic-deployer@supersonic-deploy-prod.iam.gserviceaccount.com";
