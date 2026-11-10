import { json, error } from "@sveltejs/kit";
import { wiki } from "#lib/server/wiki.ts";
import { tag, type ArticleResponse } from "#lib/article.ts";
import { normalizeIdentifier } from "#lib/identifier.ts";
import { isHex32 } from "nostr-tools/utils";
export async function GET({ url }: import("./$types").RequestEvent) {
  const d = url.searchParams.get("d") ?? "";
  if (!d || normalizeIdentifier(d) !== d) {
    error(400, "Invalid article identifier");
  }
  const object = wiki();
  const status = await object.getArticleStatus(d);
  const article = status === "published" ? await object.getArticle(d) : null;
  const revision = url.searchParams.get("revision");
  let reflectsRevision = false;
  if (article && revision && isHex32(revision)) {
    const history = await object.getHistory(d);
    const accepted = history.findIndex(
      (entry) => tag(entry.commit, "e") === revision,
    );
    const published = history.findIndex(
      (entry) => entry.commit.id === tag(article, "head"),
    );
    reflectsRevision = accepted >= 0 && published >= accepted;
  }
  return json({ status, article, reflectsRevision } satisfies ArticleResponse, {
    headers: { "Cache-Control": "no-store" },
  });
}
