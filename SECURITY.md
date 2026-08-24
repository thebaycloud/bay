# Reporting a security issue

**Do not open a public issue.**

Use GitHub's private reporting: **Security → Advisories → Report a vulnerability**
on [this repository](https://github.com/thebaycloud/bay/security/advisories/new).
It is enabled, it goes only to the maintainers, and it gives us a place to work
with you before anything is public.

If that fails for any reason, write to `founders@thebay.cloud` and say
"security" in the subject.

## What we will do

We will confirm we received it within a few days and tell you what we think it
is. If it is real we will say when it is fixed, and credit you in the advisory
unless you would rather we did not. If we think it is not a problem we will
explain why rather than going quiet — being wrong in the open is better than
leaving you guessing.

We are a small team. That means fast answers on real issues and no bug-bounty
programme.

## What is worth reporting

Bay runs other people's code and serves other people's applications, so the
things that matter most are the boundaries between tenants:

- Reaching one app's data, source bundle, or environment from another
- Reaching an app you were not granted access to, around the edge proxy
- Escaping the sandbox an app runs in, on a fleet node
- Getting the platform to run or publish code that is not ours — the CLI is
  installed and executed by coding agents, so a poisoned release is the worst
  case here
- Anything that lets a request act as somebody else's account

## What is already known, and is not a finding

The repository documents its own architecture in detail, including things that
used to be true. Two in particular have been reported before and are closed:

- **`docs/VM-FLEET.md` describes apps as world-invokable at their `*.run.app`
  URL, with the proxy's visibility checks bypassable.** That was written while
  the Cloud Run application lane existed and `SEAL_APPS` was off. That lane was
  removed on 16 August 2026; applications run on the fleet, `SEAL_APPS=1`, and
  there are no customer Cloud Run services at all.
- **The same document warns that apps inherit a service account with
  project-wide roles.** `APP_RUNTIME_SERVICE_ACCOUNT` is set, and the default
  compute account has been narrowed to four read-scoped roles.

Historical documents in `docs/` are a record of what was true when they were
written, not a description of production today. If something there looks alive
and dangerous, it is worth asking — but check the date first.

## Scope

The platform at `thebay.cloud` and this repository. Applications that customers
deploy on it are theirs; if you find a problem in one of those, tell its owner,
not us — unless the problem is that Bay let you reach it.
