import { compareEvents, type Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { parseFilter, matches, searchRank, searchText } from "./protocol";

export function getArticleStatus(
  sql: SqlStorage,
  d: string,
): "available" | "published" | "unpublished" {
  const article = sql
    .exec<{ is_published: number }>(
      "SELECT is_published FROM articles WHERE d = ?",
      d,
    )
    .toArray()[0];
  return article
    ? article.is_published === 1
      ? "published"
      : "unpublished"
    : "available";
}

export function getArticle(sql: SqlStorage, d: string): Event | null {
  return (
    sql
      .exec<{ data: string }>(
        `SELECT e.data FROM articles a JOIN events e ON e.id = a.published_event_id
     WHERE a.d = ? AND a.is_published = 1`,
        d,
      )
      .toArray()
      .map((row) => JSON.parse(row.data) as Event)[0] ?? null
  );
}

export function getHistory(
  sql: SqlStorage,
  d: string,
): { commit: Event; revision: Event | null }[] {
  return sql
    .exec<{ commit_data: string; revision_data: string | null }>(
      `SELECT c.data AS commit_data, r.data AS revision_data
     FROM articles a JOIN events c ON c.article_d = a.d AND c.kind = 3818
     LEFT JOIN events r ON r.id = c.ref_event_id
     WHERE a.d = ? AND a.is_published = 1 ORDER BY c.seq`,
      d,
    )
    .toArray()
    .map((row) => ({
      commit: JSON.parse(row.commit_data) as Event,
      revision:
        row.revision_data === null
          ? null
          : (JSON.parse(row.revision_data) as Event),
    }));
}

export function queryEvents(sql: SqlStorage, filters: Filter[]): Event[] {
  const results = new Map<string, Event>();
  for (const input of filters) {
    const filter = parseFilter(input);
    if (filter.limit === 0) {
      continue;
    }
    const query =
      filter.search === undefined ? undefined : searchText(filter.search);
    if (query !== undefined && [...query].length < 3) {
      continue;
    }
    let statement =
      query === undefined
        ? `SELECT e.data FROM events e JOIN articles a ON a.d = e.article_d WHERE a.is_published = 1`
        : `SELECT e.data FROM article_fts f JOIN articles a ON a.id = f.rowid
         JOIN events e ON e.id = a.published_event_id WHERE a.is_published = 1 AND article_fts MATCH ?`;
    const bindings: SqlStorageValue[] =
      query === undefined ? [] : [`"${query.replaceAll('"', '""')}"`];
    if (filter.since !== undefined) {
      statement += " AND e.created_at >= ?";
      bindings.push(filter.since);
    }
    if (filter.until !== undefined) {
      statement += " AND e.created_at <= ?";
      bindings.push(filter.until);
    }
    const constrain = (column: string, literals: string[]) => {
      const constraint = ` AND ${column} IN (${literals.join(",")})`;
      // SQL is ASCII here. Larger lists are still checked by matches() below.
      if (statement.length + constraint.length <= 100_000) {
        statement += constraint;
      }
    };
    if (filter.kinds) {
      constrain("e.kind", filter.kinds.map(String));
    }
    if (filter.ids) {
      constrain(
        "e.id",
        filter.ids.map((id) => `X'${id}'`),
      );
    }
    if (filter.authors) {
      constrain(
        "e.pubkey",
        filter.authors.map((author) => `X'${author}'`),
      );
    }
    const rows = sql.exec<{ data: string }>(statement, ...bindings);
    const events = rows
      .toArray()
      .map((row) => JSON.parse(row.data) as Event)
      .filter((event) => matches(event, filter));
    events.sort(
      query === undefined
        ? compareEvents
        : (a, b) =>
            searchRank(a, query) - searchRank(b, query) || compareEvents(a, b),
    );
    for (const event of events.slice(0, filter.limit)) {
      results.set(event.id, event);
    }
  }
  const events = [...results.values()];
  return filters.every((filter) => filter.search === undefined)
    ? events.sort(compareEvents)
    : events;
}
