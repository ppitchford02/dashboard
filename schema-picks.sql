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


-- A scheduled pass is only verified when it writes this final receipt. A clean
-- process exit without a receipt is deliberately indistinguishable from no run.
CREATE TABLE IF NOT EXISTS automation_run_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('complete','no_work','blocked','failed')),
  accounts_checked INTEGER NOT NULL CHECK (accounts_checked >= 0),
  accounts_blocked INTEGER NOT NULL CHECK (accounts_blocked >= 0),
  picks_saved INTEGER NOT NULL CHECK (picks_saved >= 0),
  checks_saved INTEGER NOT NULL CHECK (checks_saved >= 0),
  note TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_receipts_owner_time ON automation_run_receipts(owner,completed_at);

CREATE TABLE IF NOT EXISTS pick_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  pick_id TEXT NOT NULL REFERENCES picks(id),
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_owner_pick ON pick_revisions(owner,pick_id);

-- Private reel evidence. Audio transcripts only: captions and viewer comments are
-- never a source for a pick. Never published, never copied into the repository.
CREATE TABLE IF NOT EXISTS reel_transcripts (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (source_id IN ('sbd','bat','stunad','danny','nick','cru')),
  account_id TEXT NOT NULL CHECK (length(account_id) > 0),
  source_url TEXT NOT NULL CHECK (source_url LIKE 'https://%'),
  medium TEXT NOT NULL CHECK (medium IN ('audio')),
  engine TEXT NOT NULL,
  transcript TEXT NOT NULL CHECK (length(transcript) > 0),
  transcribed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reels_owner_time ON reel_transcripts(owner,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reels_owner_url ON reel_transcripts(owner,source_url);

-- A stored transcript is evidence; it is never rewritten after capture.
CREATE TRIGGER IF NOT EXISTS reel_transcripts_immutable
BEFORE UPDATE ON reel_transcripts
BEGIN
  SELECT RAISE(ABORT,'reel transcripts are immutable');
END;
