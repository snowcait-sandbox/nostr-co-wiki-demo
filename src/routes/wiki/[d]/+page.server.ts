import { publicArticle } from "#lib/server/wiki.ts";
import { renderArticle } from "#lib/server/render.ts";
export async function load({ params }: import("./$types").PageServerLoadEvent) {
  const article = await publicArticle(params.d);
  return { article, html: renderArticle(article.content) };
}
