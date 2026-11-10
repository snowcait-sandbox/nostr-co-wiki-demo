import { wiki } from "#lib/server/wiki.ts";
export function GET({ request }: import("./$types").RequestEvent) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Upgrade required", { status: 426 });
  }
  const url = new URL(request.url);
  url.pathname = "/";
  return wiki().fetch(new Request(url, request));
}
