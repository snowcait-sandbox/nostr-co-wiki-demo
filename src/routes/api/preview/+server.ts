import { json, error } from "@sveltejs/kit";
import { renderArticle } from "#lib/server/render.ts";
export async function POST({ request }: import("./$types").RequestEvent) {
  const input: unknown = await request.json();
  if (
    typeof input !== "object" ||
    input === null ||
    !("content" in input) ||
    typeof input.content !== "string"
  ) {
    error(400, "Expected Djot content");
  }
  return json({ html: renderArticle(input.content) });
}
