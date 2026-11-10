# NostrCoWiki Database Design

## Scope

This document defines the initial SQLite schema and persistence rules for the Wiki Durable Object. Component responsibilities and request flows belong to [architecture.md](architecture.md). Event formats, Revision acceptance rules, and externally observable behavior belong to [protocol.md](protocol.md).

Each Wiki uses the SQLite storage built into its own Durable Object. The initial schema consists of exactly four tables: `events`, `articles`, `article_fts`, and `event_receipts`.

## Schema

### `events`

```sql
CREATE TABLE events (
  id BLOB PRIMARY KEY NOT NULL,
  kind INTEGER NOT NULL,
  pubkey BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  article_d TEXT NOT NULL,
  ref_event_id BLOB,
  seq INTEGER,
  data TEXT NOT NULL
);
```

- `id` and `pubkey` contain 32-byte binary values. `ref_event_id`, when present, also contains a 32-byte event ID.
- `created_at` is a Unix timestamp in seconds.
- `article_d` identifies the article associated with the event.
- `ref_event_id` identifies the accepted Revision for a Commit (`kind = 3818`); otherwise it is nullable.
- `seq` contains an article-specific sequence number for Commits; otherwise it is nullable.
- `data` holds the complete signed Nostr event JSON and is the authoritative event representation. Other columns are extracted for queries.
- Event IDs and public keys use binary storage in SQLite and lowercase hexadecimal strings on the Nostr wire.

Accepted Revisions and Commits retain their complete history. For each article, only the latest published Article event is retained.

### `articles`

```sql
CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  d TEXT NOT NULL UNIQUE,
  head_commit_id BLOB NOT NULL,
  published_event_id BLOB,
  is_published INTEGER NOT NULL
);
```

- `id` is the internal article ID and corresponds to `article_fts.rowid`.
- `d` uniquely identifies an article within the Wiki.
- `head_commit_id` points to the latest confirmed Commit.
- `published_event_id` points to the published Article event, if present.
- `is_published` represents the publication state: `1` for published, `0` for unpublished.

### `article_fts`

```sql
CREATE VIRTUAL TABLE article_fts USING fts5(
  d,
  title,
  summary,
  content,
  tokenize = 'trigram'
);
```

- The FTS row ID is the corresponding `articles.id`.
- Only published Articles are indexed.
- Article changes and FTS updates are committed in the same SQLite transaction.
- Search covers `d`, `title`, `summary`, and `content` and follows the ranking requirements in [protocol.md](protocol.md). The detailed ranking SQL is not specified here.
- No separate mechanism for one- or two-character searches is part of the initial design.

### `event_receipts`

```sql
CREATE TABLE event_receipts (
  revision_id BLOB PRIMARY KEY NOT NULL,
  ip_address TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
```

- `revision_id` is the 32-byte ID of an accepted Revision, matching `events.id`.
- `ip_address` contains the IPv4 or IPv6 address obtained when the WebSocket connection was established.
- `received_at` is the receipt time as a Unix timestamp in seconds.
- A receipt is inserted on the first successful acceptance of a Revision, in the same transaction as the event and article updates.
- Resubmitting an accepted Revision does not update its receipt.
- The receipt retention period is not yet decided.

## Indexes

The following indexes are included in addition to the table primary keys and the unique constraint on `articles.d`:

```sql
CREATE UNIQUE INDEX events_article_history
  ON events (article_d, seq)
  WHERE kind = 3818;

CREATE UNIQUE INDEX events_commit_revision
  ON events (ref_event_id)
  WHERE kind = 3818;

CREATE INDEX events_kind_time
  ON events (kind, created_at DESC, id ASC);
```

No other index or generic tag table is part of the initial schema.

## Transaction Boundary

For a newly accepted Revision, the following changes are made in one SQLite transaction:

- Save the accepted Revision and its initial `event_receipts` record.
- Save the Wiki-signed Commit and update `articles.head_commit_id`.
- Save the new Wiki-signed Article, keeping only the latest published Article event for that article.
- Update `articles.published_event_id` and the FTS5 row for the published Article.

The operation commits atomically. The wait for a later Article `created_at` second, when needed, is described in [architecture.md](architecture.md). There is no separate publication queue or recovery table.

When an article is unpublished, its historical Revisions and Commits remain stored, and its FTS entry is removed. Public visibility rules are defined in [protocol.md](protocol.md).

## Initial Exclusions

The initial schema does not contain `deleted_events`, `vanished_authors`, or other tables for NIP-09/NIP-62, which are not implemented initially.

## References

- [NostrCoWiki Protocol Specification](protocol.md)
- [NostrCoWiki Architecture](architecture.md)
- [Cloudflare: SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [SQLite: CREATE TABLE](https://www.sqlite.org/lang_createtable.html)
- [SQLite: CREATE INDEX](https://www.sqlite.org/lang_createindex.html)
- [SQLite: FTS5](https://www.sqlite.org/fts5.html)
