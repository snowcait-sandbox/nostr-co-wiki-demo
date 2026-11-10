import { decode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { revisionTarget } from "./protocol";

type ArticleState = {
  id: number;
  head_commit_id: ArrayBuffer;
  published_event_id: ArrayBuffer | null;
  is_published: number;
};

export async function acceptRevision(
  storage: DurableObjectStorage,
  privateKey: string,
  revision: Event,
  ip: string,
): Promise<Event[]> {
  const key = decode(privateKey);
  if (key.type !== "nsec") {
    throw new Error("Wiki signing key must be nsec");
  }
  const pubkey = getPublicKey(key.data);
  const d = revisionTarget(revision, pubkey);
  const base = revision.tags.find((tag) => tag[0] === "e")?.[1];
  for (;;) {
    const article = storage.sql
      .exec<ArticleState>("SELECT * FROM articles WHERE d = ?", d)
      .toArray()[0];
    if (article && article.is_published !== 1) {
      throw new Error("blocked: article is unpublished");
    }
    if (
      storage.sql
        .exec(
          "SELECT id FROM events WHERE kind = 3818 AND ref_event_id = ?",
          hexToBytes(revision.id),
        )
        .toArray().length
    ) {
      return [];
    }
    const previous = article
      ? eventById(storage.sql, article.head_commit_id)
      : null;
    if (previous?.id !== base) {
      throw new Error(
        "blocked: edit conflict (base Commit does not match current article)",
      );
    }
    const published = article?.published_event_id
      ? eventById(storage.sql, article.published_event_id)
      : null;
    const now = Math.floor(Date.now() / 1000);
    if (published && published.created_at >= now) {
      // Other events may run while waiting. Re-read the article and base afterward.
      await new Promise((resolve) =>
        setTimeout(resolve, (published.created_at + 1) * 1000 - Date.now()),
      );
      continue;
    }
    const seq = previous
      ? Number(previous.tags.find((tag) => tag[0] === "seq")![1]) + 1
      : 1;
    const commit = finalizeEvent(
      {
        kind: 3818,
        created_at: now,
        content: "",
        tags: [
          ["a", `30818:${pubkey}:${d}`],
          ["e", revision.id],
          ...(previous ? [["prev", previous.id]] : []),
          ["seq", String(seq)],
        ],
      },
      key.data,
    );
    const articleEvent = finalizeEvent(
      {
        kind: 30818,
        created_at: now,
        content: revision.content,
        tags: [
          ["d", d],
          ...revision.tags.filter(
            (tag) => tag[0] === "title" || tag[0] === "summary",
          ),
          ["head", commit.id],
        ],
      },
      key.data,
    );
    storage.transactionSync(() => {
      insertEvent(storage.sql, revision, d);
      storage.sql.exec(
        "INSERT INTO event_receipts (revision_id, ip_address, received_at) VALUES (?, ?, ?)",
        hexToBytes(revision.id),
        ip,
        now,
      );
      insertEvent(storage.sql, commit, d, hexToBytes(revision.id), seq);
      if (article?.published_event_id) {
        storage.sql.exec(
          "DELETE FROM events WHERE id = ?",
          article.published_event_id,
        );
      }
      insertEvent(storage.sql, articleEvent, d);
      storage.sql.exec(
        `INSERT INTO articles (d, head_commit_id, published_event_id, is_published) VALUES (?, ?, ?, 1)
         ON CONFLICT(d) DO UPDATE SET head_commit_id = excluded.head_commit_id, published_event_id = excluded.published_event_id`,
        d,
        hexToBytes(commit.id),
        hexToBytes(articleEvent.id),
      );
      const id = storage.sql
        .exec<{ id: number }>("SELECT id FROM articles WHERE d = ?", d)
        .one().id;
      storage.sql.exec("DELETE FROM article_fts WHERE rowid = ?", id);
      storage.sql.exec(
        "INSERT INTO article_fts (rowid, d, title, summary, content) VALUES (?, ?, ?, ?, ?)",
        id,
        d,
        revision.tags.find((tag) => tag[0] === "title")?.[1] ?? d,
        revision.tags.find((tag) => tag[0] === "summary")?.[1] ?? "",
        revision.content,
      );
    });
    return [revision, commit, articleEvent];
  }
}

function eventById(sql: SqlStorage, id: ArrayBuffer): Event {
  const row = sql
    .exec<{ data: string }>("SELECT data FROM events WHERE id = ?", id)
    .one();
  return JSON.parse(row.data) as Event;
}

function insertEvent(
  sql: SqlStorage,
  event: Event,
  d: string,
  ref: Uint8Array | null = null,
  seq: number | null = null,
): void {
  sql.exec(
    "INSERT INTO events (id, kind, pubkey, created_at, article_d, ref_event_id, seq, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    hexToBytes(event.id),
    event.kind,
    hexToBytes(event.pubkey),
    event.created_at,
    d,
    ref,
    seq,
    JSON.stringify(event),
  );
}
