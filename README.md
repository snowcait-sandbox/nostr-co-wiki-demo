# NostrCoWiki

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SnowCait/nostr-co-wiki)

Deploy to your own Cloudflare account. Enter a Wiki signing private key in
`nsec1...` format for the required `WIKI_PRIVATE_KEY` Secret. To use administration,
set the optional `ADMIN_PUBLIC_KEY` runtime variable to the administrator’s
`npub1...` public key in the Worker’s Cloudflare Dashboard settings after the
first deployment. A first deployment creates a new Wiki Durable Object; data from
an existing deployment is not transferred.

Requires Node.js 24 or later and npm. A single Cloudflare Worker named
`nostr-co-wiki` serves SvelteKit, the Nostr Relay, and its SQLite-backed Wiki
Durable Object.

## Local development

Install dependencies with `npm install`. Set the Wiki signing key in the ignored
root `.dev.vars` file:

```text
WIKI_PRIVATE_KEY=<the Wiki's nsec1... private key>
```

Start the application with `npm run dev`, then open http://localhost:8787.
The command builds SvelteKit and runs one local Wrangler Worker. Restart it after
changing application code. The Relay is at `ws://localhost:8787/relay`. No
Cloudflare account is required for local development.

## Build and verification

```sh
npm exec playwright -- install chromium
npm run lint
npm run format:check
npm test
```

`npm test` generates Worker types, checks TypeScript, builds SvelteKit, and runs
Node integration tests against Workers, SQLite, WebSockets, and browser flows.
`npm run check` checks types without building. Use `npm run types` after changing
Wrangler configuration; do not edit `worker-configuration.d.ts` manually.

`npm run build` uses the Cloudflare adapter. `worker.js` re-exports its generated
Worker and the Wiki Durable Object class. The Vite configuration creates a
build-only Wrangler config in `.svelte-kit`, derived from the root config, to
keep the adapter output separate from the custom entry point.

If the OS cannot run Playwright's bundled Chromium, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible installed Chromium. CI
installs a supported Chromium and system dependencies. Tests use fixture keys
and require no Cloudflare credentials.

## Public Wiki

The site supports SSR article reading, NIP-07 creation and editing, sanitized
Djot previews, history, line differences, restoration, and search. Reading does
not require a signing extension. Conflicting edits preserve the draft. After
acceptance, the editor confirms Article publication before navigating.

Browser Relay connections use the site's origin and `/relay`: HTTPS produces
`wss://`, HTTP produces `ws://`, and local port numbers are preserved. No Relay
URL environment variable is needed. Internal reads and search use the Wiki
Durable Object binding; the public `/relay` endpoint retains NIP-01/NIP-50.

## Administration and deployment settings

Open `/admin` and `/admin/articles` on the site's host. Set `ADMIN_PUBLIC_KEY`
as a runtime variable in `npub1...` format. Missing or invalid values disable
administrative access. The same-origin `/api/admin/articles` endpoint forwards
requests unchanged to the Wiki Durable Object for NIP-98 authentication,
administrator authorization, and publication-state/FTS updates.

Configure `WIKI_PRIVATE_KEY` as a Secret on `nostr-co-wiki` before deployment.
The key stays on the server. Administrator requests are signed through NIP-07;
no administrator private key, login session, or cookie is stored by the app.
Dashboard-managed runtime variables are preserved by `keep_vars`.

The single root `wrangler.json` declares the `WIKI` binding and its SQLite class
export. No separate Relay Worker deployment is needed. Existing Durable Object
data migration is outside the scope of this structure change.
