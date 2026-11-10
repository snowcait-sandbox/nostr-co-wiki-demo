<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { waitNostr } from "nip07-awaiter";
  import { getToken } from "nostr-tools/nip98";
  import type { Event } from "nostr-tools/pure";
  import { title } from "#lib/article.ts";
  let signingAvailable = $state(false);
  let articles = $state<{ d: string; published: boolean; article: Event }[]>(
    [],
  );
  let selected = $state<Event | null>(null);
  let busy = $state(false);
  let notice = $state("");
  onMount(() => {
    const controller = new AbortController();
    waitNostr(0, { signal: controller.signal })
      .then((nostr) => {
        if (!controller.signal.aborted && nostr) {
          signingAvailable = true;
        }
      })
      .catch(() => {});
    return () => controller.abort();
  });
  async function request<T>(d?: string, published?: boolean) {
    const signer = window.nostr;
    if (!signer) {
      throw new Error("A NIP-07 signing extension is required.");
    }
    const url = new URL("/api/admin/articles", window.location.origin);
    if (d !== undefined) {
      url.searchParams.set("d", d);
    }
    const method = published === undefined ? "GET" : "PUT";
    const payload = published === undefined ? undefined : { published };
    const authorization = await getToken(
      url.href,
      method,
      (event) => signer.signEvent(event),
      true,
      payload,
    );
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Administrator authentication failed or access was denied."
          : "The administration request failed.",
      );
    }
    return response.json() as Promise<T>;
  }
  async function load() {
    busy = true;
    notice = "";
    selected = null;
    try {
      articles = await request<typeof articles>();
    } catch (error) {
      articles = [];
      notice =
        error instanceof Error ? error.message : "Unable to load articles.";
    } finally {
      busy = false;
    }
  }
  async function change(d: string, published: boolean) {
    busy = true;
    notice = "";
    try {
      await request(d, published);
      articles = await request<typeof articles>();
      selected = null;
      notice = published ? "Article republished." : "Article unpublished.";
    } catch (error) {
      notice =
        error instanceof Error
          ? error.message
          : "Unable to change publication state.";
    } finally {
      busy = false;
    }
  }
</script>

<h1>Manage articles</h1>
<a href={resolve("/admin")}>Administration dashboard</a>
{#if !signingAvailable}<p role="status">
    Waiting for a NIP-07 signing extension. Administrator requests require a
    signature.
  </p>{/if}
<button disabled={!signingAvailable || busy} onclick={load}
  >Load articles</button
>
<p role="status">{notice}</p>
{#if articles.length}<ul>
    {#each articles as item (item.d)}<li>
        <h2>{title(item.article)}</h2>
        <p>{item.published ? "Published" : "Unpublished"}</p>
        <button disabled={busy} onclick={() => change(item.d, !item.published)}
          >{item.published ? "Unpublish" : "Republish"}</button
        ><button disabled={busy} onclick={() => (selected = item.article)}
          >View content</button
        >
      </li>{/each}
  </ul>{:else}<p>No articles loaded.</p>{/if}
{#if selected}<section>
    <h2>{title(selected)}</h2>
    <pre>{selected.content}</pre>
  </section>{/if}
