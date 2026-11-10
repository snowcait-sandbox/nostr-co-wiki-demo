import { wiki } from "#lib/server/wiki.ts";
export async function load() {
  return { articles: await wiki().getRecentArticles() };
}
