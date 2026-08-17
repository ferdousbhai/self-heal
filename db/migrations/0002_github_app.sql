-- GitHub App credentials, written once by the manifest-flow callback.
--
-- The private key is here rather than in a Worker secret because the manifest
-- flow hands it back over the API: putting it in D1 lets it go straight from
-- GitHub to Cloudflare without passing through a developer machine. It only
-- ever mints installation tokens, which expire in an hour.
CREATE TABLE IF NOT EXISTS github_app (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  app_id       TEXT    NOT NULL,
  slug         TEXT    NOT NULL,
  private_key  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
