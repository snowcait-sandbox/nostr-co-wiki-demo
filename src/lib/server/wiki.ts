import { env } from "cloudflare:workers";
import { error } from "@sveltejs/kit";

export function wiki() {
  return env.WIKI.getByName("wiki");
}
export async function publicArticle(d: string) {
  const article = await wiki().getArticle(d);
  if (!article) {
    error(404, "Article not found");
  }
  return article;
}
export function relayUrl(origin: URL): string {
  const url = new URL("/relay", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
