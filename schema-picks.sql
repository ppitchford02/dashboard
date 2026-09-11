-- Private Sports Picks storage. Apply to the D1 database bound as PICKS_DB.
-- This database is separate from public GitHub Pages content and LIMITS KV.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS picks (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (source_id IN ('sbd','bat','stunad','danny','nick','cru')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  original_fingerprint TEXT NOT NULL CHECK (length(original_fingerprint) = 64),
  data TEXT NOT NULL CHECK (json_valid(data)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_picks_owner_created ON picks(owner,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_owner_fingerprint ON picks(owner,fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_owner_original ON picks(owner,original_fingerprint);

-- Check both current and original identities inside the write transaction.
-- Application preflight queries alone cannot prevent concurrent duplicates.
CREATE TRIGGER IF NOT EXISTS picks_unique_identity_insert
BEFORE INSERT ON picks
WHEN EXISTS (
  SELECT 1 FROM picks WHERE owner=NEW.owner AND
    (fingerprint IN (NEW.fingerprint,NEW.original_fingerprint) OR
     original_fingerprint IN (NEW.fingerprint,NEW.original_fingerprint))
)
BEGIN
  SELECT RAISE(ABORT,'duplicate pick fingerprint');
END;
CREATE TRIGGER IF NOT EXISTS picks_unique_identity_update
BEFORE UPDATE OF fingerprint ON picks
WHEN EXISTS (
  SELECT 1 FROM picks WHERE owner=NEW.owner AND id<>NEW.id AND
    (fingerprint=NEW.fingerprint OR original_fingerprint=NEW.fingerprint)
)
BEGIN
  SELECT RAISE(ABORT,'duplicate pick fingerprint');
END;
CREATE TRIGGER IF NOT EXISTS picks_original_evidence_immutable
BEFORE UPDATE ON picks
WHEN NEW.id<>OLD.id OR NEW.owner<>OLD.owner OR NEW.source_id<>OLD.source_id OR
  NEW.original_fingerprint<>OLD.original_fingerprint OR NEW.created_at<>OLD.created_at OR
  json_extract(NEW.data,'$.sourceId') IS NOT json_extract(OLD.data,'$.sourceId') OR
  json_extract(NEW.data,'$.sourceUrl') IS NOT json_extract(OLD.data,'$.sourceUrl') OR
  json_extract(NEW.data,'$.originalText') IS NOT json_extract(OLD.data,'$.originalText')
BEGIN
  SELECT RAISE(ABORT,'original pick evidence is immutable');
END;

CREATE TABLE IF NOT EXISTS source_checks (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (source_id IN ('sbd','bat','stunad','danny','nick','cru')),
  status TEXT NOT NULL CHECK (status IN ('Checked','No new posts','Sign-in needed','Access blocked','Needs review')),
  note TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_owner_time ON source_checks(owner,checked_at);

CREATE TABLE IF NOT EXISTS pick_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  pick_id TEXT NOT NULL REFERENCES picks(id),
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_owner_pick ON pick_revisions(owner,pick_id);
