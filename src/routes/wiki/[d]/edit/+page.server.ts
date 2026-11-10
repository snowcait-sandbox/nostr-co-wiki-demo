import { error } from "@sveltejs/kit";
import { wiki, relayUrl, publicArticle } from "#lib/server/wiki.ts";
import { tag, title } from "#lib/article.ts";
export async function load({
  params,
  url,
}: import("./$types").PageServerLoadEvent) {
  const article = await publicArticle(params.d);
  const restored = url.searchParams.get("restore") ?? undefined;
  let content = article.content;
  if (restored) {
    const entry = (await wiki().getHistory(params.d)).find(
      (entry) => entry.commit.id === restored,
    );
    if (!entry?.revision) {
      error(404, "Historical content is unavailable");
    }
    content = entry.revision.content;
  }
  return {
    d: params.d,
    title: title(article),
    content,
    summary: tag(article, "summary") ?? "",
    base: tag(article, "head")!,
    restored,
    wikiPubkey: article.pubkey,
    relayUrl: relayUrl(url),
  };
}
