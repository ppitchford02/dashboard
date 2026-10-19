-- Private read-only dashboard mirror of the canonical local obligations queue.
-- Apply to the existing PICKS_DB (or PLANNER_DB) only as part of deployment.
CREATE TABLE IF NOT EXISTS work_task_mirror (
  owner TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  synced_at TEXT NOT NULL
);
