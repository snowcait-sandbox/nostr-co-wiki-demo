import { error } from "@sveltejs/kit";
import { diffLines } from "diff";
import { publicArticle, wiki } from "#lib/server/wiki.ts";
import { renderArticle } from "#lib/server/render.ts";
export async function load({ params }: import("./$types").PageServerLoadEvent) {
  const article = await publicArticle(params.d);
  const history = await wiki().getHistory(params.d);
  const index = history.findIndex((entry) => entry.commit.id === params.commit);
  if (index < 0) {
    error(404, "Revision not found");
  }
  const entry = history[index];
  const previous = index === 0 ? "" : history[index - 1].revision?.content;
  return {
    article,
    entry,
    html: entry.revision ? renderArticle(entry.revision.content) : null,
    changes:
      entry.revision && previous !== undefined
        ? diffLines(previous, entry.revision.content)
        : null,
  };
}
