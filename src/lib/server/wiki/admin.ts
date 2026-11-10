import { decode } from "nostr-tools/nip19";
import {
  unpackEventFromToken,
  validateEventTimestamp,
} from "nostr-tools/nip98";
import { signedEvent } from "./protocol";
import type { Event } from "nostr-tools/pure";

export async function administer(
  request: Request,
  storage: DurableObjectStorage,
  administrator: unknown,
): Promise<Response> {
  const body = await request.text();
  try {
    if (typeof administrator !== "string") {
      throw new Error();
    }
    const key = decode(administrator);
    if (key.type !== "npub") {
      throw new Error();
    }
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Nostr ")) {
      throw new Error();
    }
    const event = signedEvent(await unpackEventFromToken(authorization));
    const tag = (name: string) => {
      const tags = event.tags.filter((item) => item[0] === name);
      if (tags.length !== 1) {
        throw new Error();
      }
      return tags[0][1];
    };
    if (
      event.pubkey !== key.data ||
      event.kind !== 27235 ||
      !validateEventTimestamp(event) ||
      tag("u") !== request.url ||
      tag("method") !== request.method
    ) {
      throw new Error();
    }
    if (body || event.tags.some((item) => item[0] === "payload")) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
      );
      if (
        tag("payload") !==
        Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        )
      ) {
        throw new Error();
      }
    }
  } catch {
    return Response.json(
      { error: "Administrator authentication required." },
      { status: 401 },
    );
  }
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/articles") {
    return new Response("Not Found", { status: 404 });
  }
  const sql = storage.sql;
  if (request.method === "GET") {
    const rows = sql
      .exec<{ d: string; is_published: number; data: string }>(
        "SELECT a.d, a.is_published, e.data FROM articles a JOIN events e ON e.id = a.published_event_id ORDER BY e.created_at DESC, a.d",
      )
      .toArray();
    const result = rows.map((row) => ({
      d: row.d,
      published: row.is_published === 1,
      article: JSON.parse(row.data) as Event,
    }));
    return Response.json(result);
  }
  if (request.method !== "PUT") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const d = url.searchParams.get("d");
  if (d === null) {
    return Response.json(
      { error: "Expected article identifier." },
      { status: 400 },
    );
  }
  let published: boolean;
  try {
    const input: unknown = JSON.parse(body);
    if (
      !input ||
      typeof input !== "object" ||
      !("published" in input) ||
      typeof input.published !== "boolean"
    ) {
      throw new Error();
    }
    published = input.published;
  } catch {
    return Response.json(
      { error: "Expected article identifier and publication state." },
      { status: 400 },
    );
  }
  return storage.transactionSync(() => {
    const row = sql
      .exec<{ id: number; data: string }>(
        "SELECT a.id, e.data FROM articles a JOIN events e ON e.id = a.published_event_id WHERE a.d = ?",
        d,
      )
      .toArray()[0];
    if (!row) {
      return new Response("Not Found", { status: 404 });
    }
    const article: Event = JSON.parse(row.data);
    sql.exec(
      "UPDATE articles SET is_published = ? WHERE id = ?",
      published ? 1 : 0,
      row.id,
    );
    sql.exec("DELETE FROM article_fts WHERE rowid = ?", row.id);
    if (published) {
      sql.exec(
        "INSERT INTO article_fts (rowid, d, title, summary, content) VALUES (?, ?, ?, ?, ?)",
        row.id,
        d,
        article.tags.find((tag) => tag[0] === "title")?.[1] ?? d,
        article.tags.find((tag) => tag[0] === "summary")?.[1] ?? "",
        article.content,
      );
    }
    return Response.json({ d, published });
  });
}
