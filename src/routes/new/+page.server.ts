import { wiki, relayUrl } from "#lib/server/wiki.ts";
export async function load({ url }: import("./$types").PageServerLoadEvent) {
  return {
    d: "",
    title: "",
    content: "",
    summary: "",
    wikiPubkey: await wiki().getWikiPublicKey(),
    relayUrl: relayUrl(url),
  };
}
