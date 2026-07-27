-- Add "public" visibility: anyone can open the app, no sign-in required.
-- Idempotent: drop-and-re-add so re-running is safe.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_visibility_check;
ALTER TABLE apps ADD CONSTRAINT apps_visibility_check
  CHECK (visibility IN ('private', 'shared', 'workspace', 'public'));
