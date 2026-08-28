-- Email: the send log, password reset, and address verification.
--
-- Additive and idempotent, like every file here.

-- ---------------------------------------------------------------------------
-- Every email we have sent, and why that matters more than a log line.
--
-- `invoice.payment_failed` fires once per dunning ATTEMPT — Stripe retries a
-- card roughly four times over two weeks — and Stripe also re-delivers any
-- webhook it did not get a 2xx for. Without a record keyed on the event, a
-- single failing card mails somebody the same "your payment failed" eight or
-- more times, which is the most reliable way to make a new feature look broken.
--
-- So sends are claimed, not fired: `dedupe_key` is UNIQUE, the sender INSERTs
-- before it calls the API, and a conflicting insert means somebody already sent
-- this exact thing. That makes the claim atomic even with two instances of the
-- control plane racing on the same webhook, which is the normal case on Cloud
-- Run.
--
-- The row survives the send so it doubles as the retry queue (`status`) and the
-- suppression list (a hard bounce on an address stops later sends to it).
CREATE TABLE IF NOT EXISTS sent_emails (
  id           bigserial PRIMARY KEY,
  -- What makes this send unique. Composed by the caller, never by the table:
  -- "welcome:<user_id>", "payment_failed:<stripe_invoice_id>:<attempt>", and so
  -- on. One string so the uniqueness rule lives in one place.
  dedupe_key   text NOT NULL UNIQUE,
  -- Which email this is, for metrics and for suppression that is per-kind
  -- rather than all-or-nothing.
  kind         text NOT NULL,
  recipient    text NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  subject      text NOT NULL,
  -- 'claimed'  the row is ours, the API has not been called yet
  -- 'sent'     accepted by the provider
  -- 'failed'   provider refused; `attempts` says how many times we have tried
  -- 'skipped'  no credentials configured, or the address is suppressed
  status       text NOT NULL DEFAULT 'claimed',
  attempts     int  NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The retry sweep's only query: rows still owed a send, oldest first.
CREATE INDEX IF NOT EXISTS sent_emails_pending
  ON sent_emails (created_at)
  WHERE status IN ('claimed', 'failed');

CREATE INDEX IF NOT EXISTS sent_emails_recipient ON sent_emails (recipient, kind);

-- ---------------------------------------------------------------------------
-- Addresses that must not be mailed again.
--
-- A hard bounce means the address does not exist. Continuing to send to it is
-- how a sending reputation is destroyed, and reputation is shared across every
-- email here — so a dead address collected from a typo'd signup eventually
-- sends password resets to spam for everybody.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email      text PRIMARY KEY,
  -- 'bounce' | 'complaint' | 'manual'
  reason     text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Password reset.
--
-- There was no reset at all: password accounts are real (`credentials-login.ts`,
-- `users.password_hash`) and somebody who forgot theirs was locked out with no
-- recovery path whatsoever.
--
-- The token is stored HASHED. A reset token is a bearer credential for the
-- account, so a leaked database backup or a stray query result must not be a
-- pile of working account-takeover links. Same reasoning as password_hash
-- itself, and the reason the plaintext exists only inside the email.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  -- Single use. Set when redeemed; a second redemption is refused rather than
  -- silently working, so a link forwarded or sitting in a mailbox cannot be
  -- replayed.
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Address verification, deliberately NOT a gate.
--
-- Verification is lazy on purpose: blocking the first deploy behind a click in
-- an inbox is friction in front of the one thing we want a new account to do.
-- So this records whether an address is confirmed and nothing refuses to work
-- without it. What it buys is real anyway — signup abuse already rate-limits by
-- email domain, and an unverified address is the signal that limiter cannot see.
--
-- THE FLAG ALREADY EXISTS, AND IT IS LOAD-BEARING.
--
-- `users.email_verified` came in with 034_domain_grants, where it decides
-- whether a row may satisfy a domain rule — "anyone with an @acme.com address"
-- must mean anyone who PROVED they hold one, not anyone who typed it. Until now
-- only Google and GitHub could raise it, so a password account could never
-- satisfy a domain grant even when the person genuinely owned the address.
--
-- Clicking a link we mailed to that address proves control of that mailbox,
-- which is exactly what the domain rule needs and exactly what the OAuth path
-- attests. So confirmation raises the SAME flag rather than inventing a second
-- truth beside it — this codebase has enough of those. The consequence is worth
-- stating plainly: a password user who confirms their address can now satisfy a
-- domain grant. That is the intended meaning of the flag, newly reachable, not
-- a widening of it.
--
-- This column is only the WHEN, for support questions and for telling a stale
-- verification from a fresh one. Nothing reads it to make a decision.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The address this token proves. Held here rather than read from users at
  -- redemption time, so a token minted for one address cannot verify a
  -- different one after an email change.
  email      text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications (user_id, created_at DESC);
