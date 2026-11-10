import { wiki } from "#lib/server/wiki.ts";
export async function load({ url }: import("./$types").PageServerLoadEvent) {
  const q = url.searchParams.get("q")?.trim() ?? "";
  try {
    return {
      q,
      articles: q ? await wiki().searchArticles(q) : [],
      failure: "",
    };
  } catch {
    return {
      q,
      articles: [],
      failure: "Search is unavailable. Please try again.",
    };
  }
}
