import type { Event } from "nostr-tools/pure";
export function tag(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}
export function articlePath(d: string): `/wiki/${string}` {
  return `/wiki/${encodeURIComponent(d)}`;
}
export function title(event: Event): string {
  return tag(event, "title") ?? tag(event, "d") ?? "Untitled";
}
export function date(timestamp: number): string {
  return new Date(timestamp * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}

export interface ArticleResponse {
  status: "available" | "published" | "unpublished";
  article: Event | null;
  reflectsRevision: boolean;
}
