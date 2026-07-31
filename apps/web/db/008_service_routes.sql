-- Where each of an app's services serves, when it has more than one.
--
-- An app was one Cloud Run service and one URL, so `run_url` answered every
-- request and the proxy needed no routing. That cannot express the shape people
-- keep building: a Next.js frontend beside a Python API. A Next app doing SSR is
-- itself a server and cannot be mounted inside FastAPI, so two servers need two
-- Cloud Run services.
--
-- Shape: [{"path": "/api", "url": "https://…"}, {"path": "/", "url": "https://…"}]
-- The proxy picks the LONGEST matching prefix, so storage order never decides
-- where traffic goes.
--
-- Null for every app that has one service, which is almost all of them — the
-- proxy falls back to run_url and behaves exactly as it always has.

ALTER TABLE apps ADD COLUMN IF NOT EXISTS routes jsonb;
