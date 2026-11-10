# NostrCoWiki Architecture

## Scope

NostrCoWiki is a collaboratively edited Wiki built on Nostr. Each deployment hosts one Wiki and runs exclusively on Cloudflare.

This document describes system components, their responsibilities, and the flow between them. The following documents have separate responsibilities:

- [Protocol specification](protocol.md): event formats, acceptance rules, and externally observable relay behavior. It is the authoritative source for protocol behavior.
- [Database design](database.md): the SQLite schema, indexes, and persistence rules.

## Components

| Component | Responsibility |
| --- | --- |
| SvelteKit (`src/`) | Runs on the single `nostr-co-wiki` Cloudflare Worker; serves public SSR pages, the editor, management UI and HTTP API, and the `/relay` WebSocket endpoint. |
| Wiki Durable Object (`src/lib/server/wiki/`) | SQLite-backed object owned by the same Worker; handles Nostr events, subscriptions, storage, NIP-98 authentication and administrator authorization, and publication control. |
| Identifier normalization (`src/lib/identifier.ts`) | Shared identifier generation for the UI, rendering, and Revision validation. |

`worker.js` re-exports the adapter-generated SvelteKit Worker and the `Wiki` class. The Vite configuration derives an adapter-only generated config from `wrangler.json` so the adapter writes its output to `.svelte-kit/cloudflare/_worker.js` rather than overwriting the entry point.

Nostr relay handling and Wiki-specific event processing are separate responsibilities inside the same Durable Object. The design does not introduce D1, external PostgreSQL, or external Pub/Sub.

## Communication

- **Reading:** The Worker fetches published Article data through a Durable Object binding and renders the page on the server.
- **Editing:** The browser signs Revisions through NIP-07 and sends them to the same-origin `/relay` endpoint over NIP-01 WebSocket. NIP-46 is a possible future option, not an initial dependency.
- **Subscriptions:** The Relay serves NIP-01 event subscriptions through the Wiki Durable Object.
- **Administration:** The dashboard uses the Worker's same-origin `/api/admin/articles` HTTP API. The Worker forwards requests unchanged through the existing binding to the Wiki Durable Object in the same Worker, which performs authentication, authorization, and administrative operations. Administrative operations and HTTP requests for unpublished article information require NIP-98 authentication and administrator authorization. Detailed routes and payloads are implementation concerns.

## Administration Routing

The administrator dashboard is available at `/admin` and the article management list at `/admin/articles` on the public site's host, including `workers.dev` and custom domains. The public site has no administration controls or links to the dashboard.

The dashboard shares the single Worker and its Wiki Durable Object.

## Revision Processing

The Wiki Durable Object performs Revision acceptance and publication according to [protocol.md](protocol.md).

1. Validate the editor-signed Revision and check its base Commit against the current article state.
2. For an already accepted Revision, return the appropriate acceptance result without creating another Commit or receipt.
3. If the new Article would have the same `created_at` second as the previously published Article, wait for the next second instead of using a future timestamp.
4. Commit the accepted Revision, its receipt, the Wiki-signed Commit, the Wiki-signed Article, the article state, and the full-text index update in **one SQLite transaction**.
5. Return the NIP-01 acceptance result after the transaction commits.

No publication queue, Durable Objects Alarm, timer-based publication workflow, or separate recovery mechanism is introduced.

## Storage and Queries

The Wiki Durable Object uses its built-in SQLite database. The initial model has four tables:

| Table | Responsibility |
| --- | --- |
| `events` | Stores accepted Revisions and Commits, and the latest published Article event per article. |
| `articles` | Stores each article's current Commit, published Article reference, and publication state. |
| `article_fts` | Indexes published articles for NIP-50 search. |
| `event_receipts` | Records the originating IP address and receipt time for the initial acceptance of a Revision. |

The complete schema and index definitions are in [database.md](database.md).

The Durable Object evaluates supported NIP-01 filters correctly, including filters without a dedicated index. Search returns only published Articles; its externally observable ranking rules belong to [protocol.md](protocol.md), while specific ranking SQL is left to implementation.

Unpublished articles are excluded from public rendering, search results, and relay subscription delivery. Their stored history is retained, and new Revisions for them are rejected, as specified in the protocol.

## WebSocket Connections

The Durable Object uses the WebSocket Hibernation API. Per-connection subscription state is held in WebSocket attachments and restored after hibernation.

The `/relay` route preserves the client's IP header when forwarding a WebSocket upgrade to the Durable Object at `/`, which uses it for Revision acceptance receipts.

## Keys and Administration

- `WIKI_PRIVATE_KEY`: Worker Secret containing the Wiki private key in `nsec1...` format, used for signing Commits and Articles.
- `ADMIN_PUBLIC_KEY`: environment variable containing the administrator's public key in `npub1...` format.
- The administrator's private key is not stored by the Relay. No custom login session or private-key storage mechanism is introduced.
- Administrator privileges apply to the whole Wiki, not individual articles.
- Administrators can unpublish and republish articles through the NIP-98-authenticated HTTP API without generating Revisions or Commits. Requests for unpublished article information and administrative operations require both authentication and administrator authorization based on `ADMIN_PUBLIC_KEY`; routing is not a substitute for either.

## Article Rendering

Article content is Djot. The Worker converts it to HTML and sanitizes the output before rendering. Article links follow NIP-54. The Djot library has not yet been selected.

## Repository Structure

```text
src/
  routes/
  lib/
    identifier.ts
    server/wiki/
tests/
docs/
worker.js
wrangler.json
vite.config.ts
```

Dependencies and npm commands are managed in one root package. The Deploy to Cloudflare button remains undecided.

## Initial Protocol Scope

The initial implementation supports NIP-01, NIP-50 Article search, and NIP-54 Articles. NIP-09 and NIP-62 are not implemented initially; their behavior remains specified in [protocol.md](protocol.md) for a future implementation.

## References

- [NostrCoWiki Protocol Specification](protocol.md)
- [NostrCoWiki Database Design](database.md)
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md)
- [NIP-54](https://github.com/nostr-protocol/nips/blob/master/54.md)
- [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Cloudflare: SvelteKit](https://developers.cloudflare.com/workers/framework-guides/web-apps/sveltekit/)
- [Cloudflare: SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare: WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
