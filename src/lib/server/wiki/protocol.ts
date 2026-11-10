import { normalizeIdentifier } from "../../identifier.ts";
import { validateEvent, verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilter, type Filter } from "nostr-tools/filter";
import { isHex32 } from "nostr-tools/utils";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function signedEvent(value: unknown): Event {
  if (
    !record(value) ||
    !validateEvent(value) ||
    typeof value.id !== "string" ||
    !isHex32(value.id) ||
    typeof value.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(value.sig) ||
    !integer(value.created_at) ||
    !integer(value.kind) ||
    value.kind > 65535 ||
    value.tags.some((tag) => tag.length === 0)
  ) {
    throw new Error("invalid: malformed event");
  }
  // Copy only NIP-01 fields; verification caches and extra fields are never trusted.
  const event: Event = {
    id: value.id,
    pubkey: value.pubkey,
    sig: value.sig,
    created_at: value.created_at,
    kind: value.kind,
    content: value.content,
    tags: value.tags,
  };
  if (!verifyEvent(event)) {
    throw new Error("invalid: event ID or signature");
  }
  return event;
}

export function revisionTarget(event: Event, wikiPubkey: string): string {
  if (event.kind !== 2818) {
    throw new Error("blocked: only Wiki Revisions may be submitted");
  }
  for (const name of ["a", "e", "title", "summary", "edit_summary"]) {
    const tags = event.tags.filter((tag) => tag[0] === name);
    if (tags.length > 1 || tags.some((tag) => tag.length < 2)) {
      throw new Error(`invalid: ${name} tag`);
    }
  }
  const address = event.tags.find((tag) => tag[0] === "a")?.[1];
  const prefix = `30818:${wikiPubkey}:`;
  if (!address?.startsWith(prefix)) {
    throw new Error("invalid: target Wiki address");
  }
  const d = address.slice(prefix.length);
  if (!d || normalizeIdentifier(d) !== d) {
    throw new Error("invalid: article identifier");
  }
  const base = event.tags.find((tag) => tag[0] === "e")?.[1];
  if (base !== undefined && !isHex32(base)) {
    throw new Error("invalid: base Commit ID");
  }
  return d;
}

export function parseFilter(value: unknown): Filter {
  if (!record(value)) {
    throw new Error("invalid: filter must be an object");
  }
  for (const [key, field] of Object.entries(value)) {
    if (["since", "until", "limit"].includes(key)) {
      if (!integer(field)) {
        throw new Error(`invalid: ${key} filter`);
      }
    } else if (key === "search") {
      if (typeof field !== "string") {
        throw new Error("invalid: search filter");
      }
    } else if (
      ["ids", "authors", "kinds"].includes(key) ||
      /^#[a-zA-Z]$/.test(key)
    ) {
      if (
        !Array.isArray(field) ||
        !field.every((item) =>
          key === "kinds"
            ? integer(item) && item <= 65535
            : typeof item === "string" &&
              (!["ids", "authors", "#e", "#p"].includes(key) || isHex32(item)),
        )
      ) {
        throw new Error(`invalid: ${key} filter`);
      }
    } else {
      throw new Error(`unsupported: filter ${key}`);
    }
  }
  return value as Filter;
}

export function searchText(search: string): string {
  // NIP-50 extensions are not part of the initial search interface.
  return search
    .replace(/\S+:\S+/gu, "")
    .trim()
    .toLowerCase();
}

export function searchRank(event: Event, query: string): number {
  if (event.kind !== 30818 || [...query].length < 3) {
    return Infinity;
  }
  const fields = ["d", "title", "summary"].map(
    (name) => event.tags.find((tag) => tag[0] === name)?.[1] ?? "",
  );
  fields.push(event.content);
  return Math.min(
    ...fields.map((field, index) => {
      const text = field.toLowerCase();
      const priority = Math.max(0, index - 1) * 2;
      return text === query
        ? priority
        : text.includes(query)
          ? priority + 1
          : Infinity;
    }),
  );
}

export function matches(event: Event, filter: Filter): boolean {
  return (
    matchFilter(filter, event) &&
    // nostr-tools 2.26.0 treats until: 0 as an absent bound.
    (filter.until !== 0 || event.created_at <= 0) &&
    (filter.search === undefined ||
      Number.isFinite(searchRank(event, searchText(filter.search))))
  );
}
