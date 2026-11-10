import { publicArticle, wiki } from "#lib/server/wiki.ts";
export async function load({ params }: import("./$types").PageServerLoadEvent) {
  return {
    article: await publicArticle(params.d),
    history: await wiki().getHistory(params.d),
  };
}
