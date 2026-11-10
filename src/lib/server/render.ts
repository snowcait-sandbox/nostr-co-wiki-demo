import { parse, renderHTML } from "@djot/djot";
import sanitizeHtml from "sanitize-html";
import { normalizeIdentifier } from "#lib/identifier.ts";
import { articlePath } from "../article.ts";

export function renderArticle(content: string): string {
  const html = renderHTML(parse(content), {
    overrides: {
      link(node, renderer) {
        if (
          node.reference !== undefined &&
          !Object.hasOwn(renderer.references, node.reference) &&
          !Object.hasOwn(renderer.autoReferences, node.reference)
        ) {
          return renderer.renderAstNodeDefault({
            ...node,
            reference: undefined,
            destination: articlePath(normalizeIdentifier(node.reference)),
          });
        }
        return renderer.renderAstNodeDefault(node);
      },
    },
  });
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img"],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["id", "class"],
      a: ["href", "title", "role"],
      img: ["src", "alt", "title", "width", "height"],
    },
    allowedSchemes: ["http", "https", "mailto", "nostr"],
    allowProtocolRelative: false,
  });
}
