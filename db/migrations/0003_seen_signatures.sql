-- Signatures already accepted, so a captured request cannot be replayed inside
-- the acceptance window. The timestamp window bounds how long a replay stays
-- viable; this makes it zero.
--
-- Rows are only useful until their signature's timestamp leaves the window, so
-- they are pruned on each request rather than accumulating.
CREATE TABLE IF NOT EXISTS seen_signatures (
  signature  TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS seen_signatures_expiry_idx ON seen_signatures (expires_at);
