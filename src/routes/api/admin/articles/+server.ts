import { wiki } from "#lib/server/wiki.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, setHeaders }) => {
  setHeaders({ "Cache-Control": "no-store" });
  const response = await wiki().fetch(request);
  return new Response(response.body, response);
};
export const PUT = GET;
