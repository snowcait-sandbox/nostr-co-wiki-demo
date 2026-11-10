# NostrCoWiki Protocol Specification

## 1. Overview

NostrCoWiki accepts editor-signed Revisions through a dedicated Nostr relay and confirms their acceptance through Wiki-signed Commits. Published articles are distributed as NIP-54 Article events.

This specification defines event formats, revision acceptance rules, and relay behavior for event distribution, search, and deletion requests. Event communication follows NIP-01.

## 2. Event Kinds

| Kind | Name | NIP-01 Event Type | Signer |
| --- | --- | --- | --- |
| `2818` | Wiki Revision | Regular | Editor |
| `3818` | Wiki Commit | Regular | Wiki shared key |
| `30818` | Wiki Article | Addressable | Wiki shared key |

Each Wiki uses a single shared public key. Articles are identified by `30818:<wiki-pubkey>:<d>`.

The `pubkey` of a Revision is the editor's public key. The `pubkey` of a Commit or Article is the Wiki's shared public key.

The examples below omit the common NIP-01 fields `id`, `pubkey`, `created_at`, and `sig`.

## 3. Revision (kind:2818)

A Revision represents the complete article content proposed by an editor.

```json
{
  "kind": 2818,
  "content": "Nostr is an open protocol.",
  "tags": [
    ["a", "30818:<wiki-pubkey>:nostr"],
    ["e", "<base-commit-id>"],
    ["title", "Nostr"],
    ["summary", "An overview of Nostr"],
    ["edit_summary", "Updated the overview"]
  ]
}
```

| Field / Tag | Requirement | Description |
| --- | --- | --- |
| `content` | Required | Complete article content in Djot |
| `a` | Required, exactly one | Target Article address |
| `e` | Required for existing articles, exactly one | Event ID of the base Commit |
| `title` | Optional, at most one | Article title |
| `summary` | Optional, at most one | Article summary |
| `edit_summary` | Optional, at most one | Edit description |

- When creating an article, the Revision MUST omit the `e` tag. When editing an existing article, the `e` tag is required.
- The public key in the `a` tag MUST match the target Wiki's shared public key. The `d` value MUST follow the normalization rules defined in NIP-54.
- If `title` is omitted, the `d` value is used as the title. If `summary` is omitted, the article has no summary.
- A Revision is an edit proposal until accepted. Signing and submitting a Revision does not, by itself, mean that the edit has been accepted.

## 4. Commit (kind:3818)

A Commit records the Wiki's acceptance of a Revision.

```json
{
  "kind": 3818,
  "content": "",
  "tags": [
    ["a", "30818:<wiki-pubkey>:nostr"],
    ["e", "<revision-event-id>"],
    ["prev", "<previous-commit-id>"],
    ["seq", "42"]
  ]
}
```

| Field / Tag | Requirement | Description |
| --- | --- | --- |
| `content` | Required, empty string | Contains no article content |
| `a` | Required, exactly one | Target Article address |
| `e` | Required, exactly one | Event ID of the accepted Revision |
| `prev` | Required except for the first Commit, exactly one | Event ID of the preceding Commit |
| `seq` | Required, exactly one | Article-specific sequence number, expressed as a decimal integer |

- The first Commit has `seq` equal to `1` and MUST NOT contain a `prev` tag.
- Each subsequent Commit for the same article MUST reference the preceding Commit through `prev` and increment `seq` by one.
- A Commit MUST be signed with the target Wiki's shared key.
- A Commit references the accepted Revision without duplicating its article content.

## 5. Article (kind:30818)

An Article is a published snapshot of an article, following NIP-54.

```json
{
  "kind": 30818,
  "content": "Nostr is an open protocol.",
  "tags": [
    ["d", "nostr"],
    ["title", "Nostr"],
    ["summary", "An overview of Nostr"],
    ["head", "<commit-event-id>"]
  ]
}
```

- The `d` tag is required and MUST follow the normalization rules defined in NIP-54.
- `content` MUST contain the Djot content corresponding to the accepted Revision.
- `title` and `summary` reflect the values of the accepted Revision and may be omitted.
- The custom `head` tag is required and identifies the Commit reflected by the Article.
- An Article MUST be signed with the target Wiki's shared key.
- An Article is published after its corresponding Commit has been confirmed. A published Article may temporarily lag behind the latest Commit.

### Article Update Ordering

- Multiple Article events for the same article MUST NOT be published with the same `created_at` value.
- The `created_at` value of a new Article MUST be greater than that of the previously published Article for the same article. Future timestamps MUST NOT be used to publish updates ahead of time.
- When multiple Commits are confirmed within the same second, Article publication may be deferred. Intermediate snapshots may be skipped, with a single Article reflecting the latest Commit.
- An Article reflecting an older Commit MUST NOT be published after an Article reflecting a newer Commit.
- Even if publication is delayed or fails, the published Article MUST eventually reflect the latest accepted Commit.

## 6. Revision Acceptance

Clients submit Revisions using the NIP-01 `EVENT` message. The dedicated relay validates the event ID, signature, required tags, target article, and base Commit.

### New Articles

- A Revision is accepted as a new article if the target article does not exist and the Revision has no `e` tag.
- The first Commit referencing the accepted Revision is confirmed with `seq=1`.

### Existing Articles

- A Revision is accepted only if its `e` tag references the current Commit of the target article.
- Acceptance confirms a new Commit whose `prev` tag references the preceding Commit.
- A Revision with a mismatched base Commit is rejected as a conflict. Automatic merging is not performed.

### Acceptance Results

- Each accepted Revision corresponds to exactly one Commit at the time of acceptance.
- Resubmitting the same Revision MUST NOT create another Commit. A previously accepted Revision may receive a successful response.
- Commits for the same article form a single linear history, ordered by `seq` and `prev`.
- The relay returns `OK true` only after Revision acceptance has been confirmed. `OK true` indicates that the corresponding Commit has been confirmed; it does not indicate that Article publication has completed.
- Invalid Revisions, edit conflicts, and edits to unpublished articles receive `OK false` with a reason string following NIP-01.
- Deleting a Revision does not automatically invalidate an existing Commit or revert an Article.

## 7. Event Retrieval

Published articles are retrieved using NIP-01 `REQ` messages.

```json
["REQ", "article", {
  "kinds": [30818],
  "authors": ["<wiki-pubkey>"],
  "#d": ["nostr"]
}]
```

The accepted history of an article can be retrieved by querying Commits referencing its Article address.

```json
["REQ", "history", {
  "kinds": [3818],
  "authors": ["<wiki-pubkey>"],
  "#a": ["30818:<wiki-pubkey>:nostr"]
}]
```

When the Revision referenced by a Commit is available, its content and author signature can be verified. If the Revision has been deleted, its content and author signature can no longer be verified from the remaining Commit alone.

Reverting to a previous version requires submitting a new Revision containing the content to restore and referencing the current Commit as its base. Existing Commits are not modified.

## 8. Search (NIP-50)

The dedicated relay supports the NIP-50 `search` filter and returns only the latest published Article events for publicly available articles.

```json
["REQ", "search", {
  "kinds": [30818],
  "authors": ["<wiki-pubkey>"],
  "search": "nostr",
  "limit": 20
}]
```

- Searchable fields are `d`, `title`, `summary`, and `content`.
- Relevance prioritizes `d` and `title`, followed by `summary`, then `content`. Exact matches take precedence over partial matches within the same field.
- Search supports multilingual text, including Japanese.
- Results are returned in relevance order.
- Search results MUST contain published Article events, not unpublished snapshots.
- Unpublished articles MUST be excluded from search results.

## 9. Deletion Requests

### NIP-09 (kind:5)

- If the deletion request is signed by the author of the target Revision, the Revision is deleted or excluded from distribution.
- Deleted Revisions MUST NOT be returned in subsequent `REQ` responses.
- Deleting a Revision does not automatically delete or update Commits and Articles signed with the Wiki's shared key.

### NIP-62 (kind:62)

- A valid request targeting the relay, or specifying `ALL_RELAYS`, causes events authored by the requesting public key up to the specified timestamp to be deleted.
- Deleted events MUST be prevented from being accepted again.
- A request signed by an editor's key does not constitute a deletion request for Commits or Articles signed with the Wiki's shared key.

Missing historical Revisions are not automatically reconstructed through additional events. Deletion of events already stored by external relays or clients cannot be guaranteed.

## 10. Article Publication Control

- Only Wiki administrators may unpublish or republish articles. Article-specific administrative permissions are not defined.
- Unpublishing or republishing an article does not generate a Revision or Commit.
- While an article is unpublished, its Article, Revision, and Commit events MUST be excluded from the dedicated relay's `REQ` responses and subscription delivery. New Revisions for the article MUST be rejected.
- NIP-09 and NIP-62 deletion requests MUST continue to be processed while an article is unpublished.
- Republishing an article makes its latest confirmed article state available for publication.

## 11. References

- [NIP-01 — Basic Protocol Flow Description](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-09 — Event Deletion Request](https://github.com/nostr-protocol/nips/blob/master/09.md)
- [NIP-50 — Search Capability](https://github.com/nostr-protocol/nips/blob/master/50.md)
- [NIP-54 — Wiki](https://github.com/nostr-protocol/nips/blob/master/54.md)
- [NIP-62 — Request to Vanish](https://github.com/nostr-protocol/nips/blob/master/62.md)
