-- What a node says about the processes it was given.
--
-- The node has always known when a start failed because of the node — its Cloud
-- SQL proxy is not answering, its service account cannot read a secret — and it
-- logged that and dropped it. The control plane saw only silence at the load
-- balancer, concluded the app was broken, and handed an LLM repair agent the
-- customer's repository with write access. This table is where the node's own
-- verdict lands so that stops happening.
--
-- Only failures are stored. A process that starts is absent, so the table stays
-- small and "is there a row" is itself the question the reader asks.
CREATE TABLE IF NOT EXISTS fleet_process_faults (
  slug        text NOT NULL,
  node        text NOT NULL REFERENCES fleet_nodes(name) ON DELETE CASCADE,
  process     text NOT NULL,
  -- 'node', 'app' or 'unknown', decided on the node by classifyStartError.
  -- Deliberately NOT a CHECK constraint: the vocabulary lives in the agent, the
  -- agent is deployed separately from this schema (scp and build on the node,
  -- never a push to main), and a new value arriving from a newer agent must be
  -- stored and ignored by an older reader rather than rejected — a constraint
  -- here would make every sync from that node fail instead.
  fault       text NOT NULL,
  -- The error text, and only ever for a classified fault: an unclassified start
  -- error can contain the tail of the app's own log, which is the customer's
  -- stdout. The agent withholds it (see faultDetail); this column is the reason
  -- that matters, because this is where it would stop being the node's business.
  detail      text,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, node, process)
);

CREATE INDEX IF NOT EXISTS fleet_process_faults_slug_idx ON fleet_process_faults (slug);
