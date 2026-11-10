export const schema = `
CREATE TABLE IF NOT EXISTS events (
  id BLOB PRIMARY KEY NOT NULL,
  kind INTEGER NOT NULL,
  pubkey BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  article_d TEXT NOT NULL,
  ref_event_id BLOB,
  seq INTEGER,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  d TEXT NOT NULL UNIQUE,
  head_commit_id BLOB NOT NULL,
  published_event_id BLOB,
  is_published INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS article_fts USING fts5(
  d, title, summary, content, tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS event_receipts (
  revision_id BLOB PRIMARY KEY NOT NULL,
  ip_address TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_article_history
  ON events (article_d, seq) WHERE kind = 3818;
CREATE UNIQUE INDEX IF NOT EXISTS events_commit_revision
  ON events (ref_event_id) WHERE kind = 3818;
CREATE INDEX IF NOT EXISTS events_kind_time
  ON events (kind, created_at DESC, id ASC);
`;
