-- Private "Today's list" storage. Apply to the same D1 database bound as
-- PICKS_DB (or to a dedicated database bound as PLANNER_DB).
-- This database is separate from public GitHub Pages content and LIMITS KV.
-- Daily planning is personal, so it is never written into data.json, the
-- published page, or the GitHub repository.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS planner_days (
  owner TEXT NOT NULL,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  tasks TEXT NOT NULL CHECK (json_valid(tasks) AND json_type(tasks) = 'array'),
  prompted INTEGER NOT NULL DEFAULT 0 CHECK (prompted IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, day)
);
CREATE INDEX IF NOT EXISTS idx_planner_owner_day ON planner_days(owner, day DESC);

-- A day's row only ever moves forward. Rejecting stale revisions inside the
-- write keeps two devices editing the same list from silently overwriting
-- each other; the application surfaces the conflict instead.
CREATE TRIGGER IF NOT EXISTS planner_revision_advances
BEFORE UPDATE ON planner_days
WHEN NEW.revision <> OLD.revision + 1 OR NEW.owner <> OLD.owner OR NEW.day <> OLD.day
BEGIN
  SELECT RAISE(ABORT, 'planner revision must advance by one');
END;
