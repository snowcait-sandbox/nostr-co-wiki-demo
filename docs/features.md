# NostrCoWiki Features

## Scope

This document defines the user-facing features and acceptance criteria for the initial implementation of NostrCoWiki.

The following documents are authoritative for their respective concerns:

- [Protocol specification](protocol.md): Nostr events, acceptance rules, and relay behavior.
- [Architecture](architecture.md): system components, communication, and processing responsibilities.
- [Database design](database.md): SQLite schema and persistence rules.

Implementation details, library choices, and visual design are not prescribed unless necessary to define user-facing behavior.

## Home Page

The home page provides:

- An article search form.
- A list of recently updated, publicly available articles.
- Links from the article list to individual article pages.

Articles are listed in descending order of their latest published update time.

### Acceptance Criteria

- Visitors can discover recently updated articles without authentication.
- Unpublished articles do not appear.
- Selecting an article opens its detail page.
- Submitting a search query opens the search results page.

## Article Reading

Public articles are available at `/wiki/{d}`, where `d` is the article identifier defined by NIP-54.

Article pages display the title and rendered Djot content, with the summary available for presentation.

Pages are server-side rendered. Djot is converted to HTML and sanitized before rendering. Article links follow NIP-54.

The `/wiki/` prefix is fixed in the initial implementation.

### Acceptance Criteria

- Published articles can be read without a signing extension.
- Article content is available through server-side rendering.
- Djot content and Wiki links are rendered correctly.
- Unpublished articles are not publicly accessible.
- Article URLs use the article's `d` identifier.

## Article Creation

Article creation uses a single screen containing:

- A required title input.
- The `d` identifier generated from the title using NIP-54 normalization rules and the resulting article URL.
- The result of the duplicate identifier check.
- A Djot source editor.
- An HTML preview.
- An optional summary.
- An optional edit summary.
- A submission action.

The generated `d` cannot be edited manually. Changing the title regenerates `d` and checks for duplicates again. Changing the title does not discard entered content, summary, or edit summary.

If a published article uses the identifier, the screen displays a link to that article and does not allow submission. If an unpublished article uses the identifier, the screen indicates that the URL is unavailable and does not allow submission; it does not show the unpublished article's content or an administrative link. The user may continue editing content while an identifier is duplicated.

An availability check does not reserve the identifier. The Relay performs the final duplicate check when the user signs the new Revision using NIP-07 and submits it through the dedicated Relay. No automatic numeric suffix or identifier reservation mechanism is introduced. A WYSIWYG editor is not included.

### Acceptance Criteria

- Title, generated identifier and URL, duplicate check, editor, preview, summary, edit summary, and submission are available on one screen.
- Changing the title regenerates the identifier and rechecks for duplicates without discarding entered content, summary, or edit summary.
- A duplicate published identifier links to the existing article and prevents submission.
- A duplicate unpublished identifier is reported as unavailable without exposing its content or an administrative link, and prevents submission.
- Users can continue editing content while an identifier is duplicated.
- The Relay performs the final duplicate check at submission time.
- A valid new article can be created through the Web UI.
- The submitted article becomes available at `/wiki/{d}` after successful acceptance and publication.
- If another user creates the same article before submission, the resulting conflict is reported.
- Rejected submissions are not presented as successful publications.

## Article Editing

Existing articles can be edited using the same Djot source editor and HTML preview.

The editor loads the current article content and its base Commit.

Users may update the article title, summary, content, and edit summary.

Changing the title does not change the article's `d` identifier or URL.

Revisions are signed through NIP-07 and sent to the Relay.

### Acceptance Criteria

- Users can modify an existing published article.
- Accepted edits update the published article.
- The article URL remains unchanged when its title changes.
- A conflicting edit is reported to the user.
- The user's entered edits are preserved when a conflict occurs.
- Users can inspect the latest article and manually adjust their changes.
- Automatic merging is not performed.
- A rejected Revision does not silently overwrite the current article.

## Signing Availability

NIP-07 is the signing mechanism for the initial implementation.

Article reading does not require a signing extension.

When NIP-07 signing is unavailable, the application informs the user that a compatible signing capability is required to create or edit articles.

The initial implementation does not introduce a custom key store or login system.

### Acceptance Criteria

- Public article reading works without NIP-07.
- Users receive a clear explanation when signing is unavailable.
- The application does not attempt to submit unsigned Revisions.

## Article History

Each article provides access to its accepted editing history.

The history view displays:

- Revision order and timestamps.
- Editor identities.
- Edit summaries, when available.
- Links to view historical content.
- Changes made relative to the preceding Revision.

### Difference View

Differences are displayed using line-based comparisons of Djot source content.

The initial implementation compares each Revision with its immediate predecessor.

Arbitrary comparison between two selected historical versions is not required.

### Revision Restoration

Users can restore historical article content.

Restoration creates a new Revision containing the selected historical content and referencing the current Commit as its base.

The user signs and submits the new Revision using the normal editing process.

If restoration conflicts with a newer Commit, the user is notified, the restoration content is preserved, and the user can inspect the latest article and manually adjust the content before resubmitting. Automatic merging is not performed.

Previous Revisions and Commits are not modified or removed.

### Acceptance Criteria

- Users can browse an article's editing history.
- Users can inspect a historical version.
- Users can see the changes introduced by a Revision.
- Users can restore historical content without rewriting existing history.
- A successful restoration appears as a new entry in the history.
- Restoration conflicts follow the normal Revision acceptance rules.

## Article Search

The home page provides a search form.

Search results are displayed at `/search?q=...`.

Each result displays:

- Article title.
- Article summary, when available.
- A link to `/wiki/{d}`.

Results are ordered by relevance according to [protocol.md](protocol.md).

Search uses the dedicated Relay's NIP-50 capability.

Advanced search filters and a separate advanced-search interface are not included.

### Acceptance Criteria

- Users can search articles from the home page.
- Search queries are represented in the URL.
- Results link to the corresponding article pages.
- Results follow the relevance ordering defined by the protocol.
- Unpublished articles do not appear in search results.

## Article Administration

Wiki administrators can unpublish and republish articles.

Administrative actions use NIP-98 authentication.

An administrator-only dashboard is provided on the public site's host under `/admin`, including on `workers.dev` and custom domains, as described in [architecture.md](architecture.md#administration-routing). The public site does not contain administrative controls or links to the dashboard.

The dashboard lists published and unpublished articles and shows each article's publication state. It allows authorized administrators to unpublish published articles and republish unpublished articles. Administrators can access unpublished articles through the dashboard. No custom administrative private-key storage is introduced.

Administration permissions apply to the entire Wiki.

### Acceptance Criteria

- Administrators can access the dashboard at `/admin` and the article list at `/admin/articles` on the public host, including `workers.dev` and custom domains.
- Authorized administrators can unpublish a published article.
- The administrator-only dashboard lists published and unpublished articles and shows their publication state.
- Authorized administrators can access unpublished articles through the dashboard.
- Unpublished articles are removed from public reading, search results, and public relay distribution as specified in the protocol.
- Authorized administrators can republish unpublished articles.
- Republishing makes the latest confirmed article state available again.
- Administrative actions do not create new Revisions or Commits.
- The public site contains no administrative controls or dashboard links.
- Non-administrators cannot retrieve unpublished information or perform administrative actions.
- Unauthorized administrative requests are rejected.

## Initial Exclusions

The initial implementation does not include:

- WYSIWYG editing.
- Arbitrary comparison between historical versions.
- Automatic edit merging.
- Configurable article URL prefixes.
- Custom private-key storage or login.
- NIP-46 signing.
- Advanced search filters.
- NIP-09 or NIP-62 support.

Future features are not implemented speculatively.

## Acceptance and Implementation

Each feature should be implemented with tests that verify its observable behavior and relevant failure cases.

Tests must cover the interaction between Web, Relay, and persistent state when the feature depends on multiple components.

Implementation must respect the authoritative protocol, architecture, and database documents. Existing design decisions must not be changed solely for implementation convenience.

Library choices, internal code structure, and visual layout may be determined during implementation, provided the documented behavior is preserved.

## References

- [NostrCoWiki Protocol Specification](protocol.md)
- [NostrCoWiki Architecture](architecture.md)
- [NostrCoWiki Database Design](database.md)
- [NIP-07 — Browser Signing](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-54 — Wiki](https://github.com/nostr-protocol/nips/blob/master/54.md)
