<script lang="ts">
  import RenderedArticle from "#lib/components/RenderedArticle.svelte";
  import { resolve } from "$app/paths";
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { waitNostr } from "nip07-awaiter";
  import { normalizeIdentifier } from "#lib/identifier.ts";
  import { articlePath, tag, type ArticleResponse } from "#lib/article.ts";
  import { createRevision, submitRevision } from "#lib/submission.ts";
  import type { Event } from "nostr-tools/pure";
  let {
    data,
  }: {
    data: {
      d: string;
      title: string;
      content: string;
      summary: string;
      base?: string;
      restored?: string;
      wikiPubkey: string;
      relayUrl: string;
    };
  } = $props();
  const initial = untrack(() => data);
  let articleTitle = $state(initial.title);
  let content = $state(initial.content);
  let summary = $state(initial.summary);
  let editSummary = $state(
    initial.restored ? `Restore content from ${initial.restored}` : "",
  );
  let base = $state(initial.base);
  const d = $derived(data.base ? data.d : normalizeIdentifier(articleTitle));
  let origin = $state("");
  let signingAvailable = $state(false);
  let availability = $state("checking");
  let preview = $state("");
  let previewError = $state("");
  let busy = $state(false);
  let notice = $state("");
  let outcome = $state("");
  let acceptedId = $state("");
  let latest = $state<Event | null>(null);
  onMount(() => {
    origin = window.location.origin;
    const controller = new AbortController();
    waitNostr(0, { signal: controller.signal })
      .then((nostr) => {
        if (!controller.signal.aborted && nostr) {
          signingAvailable = true;
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error("Unable to detect the signing extension", error);
        }
      });
    return () => controller.abort();
  });
  $effect(() => {
    const identifier = d;
    if (data.base) {
      availability = "published";
      return;
    }
    availability = identifier ? "checking" : "invalid";
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!identifier) {
        return;
      }
      try {
        const response = await fetch(
          `/api/article?d=${encodeURIComponent(identifier)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error();
        }
        const result = (await response.json()) as ArticleResponse;
        if (!controller.signal.aborted) {
          availability = result.status;
        }
      } catch {
        if (!controller.signal.aborted) {
          availability = "error";
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
  $effect(() => {
    const source = content;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: source }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error();
        }
        const result = (await response.json()) as { html: string };
        if (!controller.signal.aborted) {
          preview = result.html;
          previewError = "";
        }
      } catch {
        if (!controller.signal.aborted) {
          previewError = "Preview is unavailable. Your source is preserved.";
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
  async function checkPublication() {
    busy = true;
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(
          `/api/article?d=${encodeURIComponent(d)}&revision=${acceptedId}`,
        );
        if (!response.ok) {
          throw new Error();
        }
        const result = (await response.json()) as ArticleResponse;
        if (result.article && result.reflectsRevision) {
          await goto(resolve("/wiki/[d]", { d }), { refreshAll: true });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      notice =
        "Your Revision was accepted, but publication is not yet confirmed. You can check again.";
    } catch {
      notice =
        "Your Revision was accepted. Unable to check publication right now; check again before resubmitting.";
    } finally {
      busy = false;
    }
  }
  async function loadLatest() {
    try {
      const response = await fetch(`/api/article?d=${encodeURIComponent(d)}`);
      if (!response.ok) {
        throw new Error();
      }
      latest = ((await response.json()) as { article: Event | null }).article;
      if (!latest) {
        notice =
          "This article is no longer publicly available. Your draft is preserved.";
      }
    } catch {
      notice = "Unable to load the latest article. Your draft is preserved.";
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    notice = "Waiting for your signing extension and Relay response…";
    outcome = "";
    busy = true;
    latest = null;
    const result = await submitRevision(
      window.nostr,
      data.relayUrl,
      createRevision({
        wikiPubkey: data.wikiPubkey,
        d,
        title: articleTitle,
        summary,
        editSummary,
        content,
        base,
      }),
    );
    outcome = result.type;
    notice = result.message;
    busy = false;
    if (result.type === "accepted" && result.id) {
      acceptedId = result.id;
      await checkPublication();
    } else if (result.type === "conflict") {
      await loadLatest();
    }
  }
</script>

{#if data.restored}<p>
    Restoring historical content from {data.restored}. Review your draft before
    signing.
  </p>{/if}
{#if !signingAvailable}<p role="status">
    Waiting for a NIP-07 compatible signing extension. One is required to create
    or edit articles. Reading remains available.
  </p>{/if}
<form onsubmit={submit}>
  <fieldset disabled={busy || !!acceptedId}>
    <label for="title">Title (required)</label><input
      id="title"
      bind:value={articleTitle}
      required
    />
    <p>Article identifier: <code>{d || "Enter a title"}</code></p>
    <p>Article URL: <output>{origin}{articlePath(d)}</output></p>
    {#if !data.base}<p aria-live="polite">
        {#if availability === "published"}This article already exists. <a
            href={resolve("/wiki/[d]", { d })}>Read the existing article</a
          >. Submission is unavailable.
        {:else if availability === "unpublished"}This URL is unavailable.
        {:else if availability === "available"}This identifier is available. It
          is not reserved.
        {:else if availability === "checking"}Checking the identifier…
        {:else if availability === "error"}Unable to check this identifier.
          Please try changing the title again.
        {:else}Enter a title that produces a valid identifier.{/if}
      </p>{/if}
    <label for="content">Djot source</label><textarea
      id="content"
      bind:value={content}
      rows="18"></textarea>
    <label for="summary">Summary (optional)</label><textarea
      id="summary"
      bind:value={summary}
      rows="2"></textarea>
    <label for="edit-summary">Edit summary (optional)</label><input
      id="edit-summary"
      bind:value={editSummary}
    />
    <button
      disabled={!signingAvailable ||
        !articleTitle.trim() ||
        !d ||
        (!data.base && availability !== "available")}
      >Sign and submit Revision</button
    >
  </fieldset>
</form>
<p role="status" aria-live="polite">{notice}</p>
{#if acceptedId}<button onclick={checkPublication} disabled={busy}
    >Check publication</button
  >{/if}
{#if outcome === "conflict"}<section>
    <h2>Resolve the edit conflict</h2>
    <p>
      Your draft has been preserved. Review the latest article, manually adjust
      your changes, then choose its Commit as your new base.
    </p>
    <a href={resolve("/wiki/[d]", { d })} target="_blank" rel="noopener"
      >Open latest article</a
    > <button onclick={loadLatest}>Refresh latest article</button>
    {#if latest}<h3>{tag(latest, "title") ?? d}</h3>
      <pre>{latest.content}</pre>
      <button
        onclick={() => {
          base = tag(latest!, "head");
          notice =
            "Using the displayed Commit as base. Your draft is unchanged; review it before resubmitting.";
        }}>Use this Commit as base</button
      >{/if}
  </section>{/if}
<section>
  <h2>HTML preview</h2>
  {#if previewError}<p role="alert">{previewError}</p>{/if}
  <div class="prose"><RenderedArticle html={preview} /></div>
</section>
