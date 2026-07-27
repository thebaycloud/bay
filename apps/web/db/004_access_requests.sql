-- Access requests: someone without access asks the owner to let them in.
-- The owner approves (which grants + emails them) or denies from the Share panel.
CREATE TABLE IF NOT EXISTS access_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email       text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_requests_status_check CHECK (status IN ('pending', 'approved', 'denied')),
  CONSTRAINT access_requests_app_email UNIQUE (app_id, email)
);
