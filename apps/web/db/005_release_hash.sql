-- The content hash of the live release.
--
-- Lets a redeploy whose build output is byte-identical skip the upload entirely: the
-- CLI hashes what it built, asks whether that hash is already live, and stops if it is.
--
-- Written in the same statement that moves the pointer, so the two can never disagree.
-- Null for every app deployed before this and for anything built in the cloud.

ALTER TABLE apps ADD COLUMN IF NOT EXISTS release_hash text;
