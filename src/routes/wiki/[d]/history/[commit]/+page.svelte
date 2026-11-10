<script lang="ts">
  import RenderedArticle from "#lib/components/RenderedArticle.svelte";
  import { resolve } from "$app/paths";
  import { tag, title, date } from "#lib/article.ts";
  let { data }: import("./$types").PageProps = $props();
</script>

<svelte:head
  ><title>Revision {tag(data.entry.commit, "seq")} — NostrCoWiki</title
  ></svelte:head
>
<h1>{title(data.article)} — Revision {tag(data.entry.commit, "seq")}</h1>
<p>{date(data.entry.commit.created_at)}</p>
<nav aria-label="History">
  <a href={resolve("/wiki/[d]/history", { d: tag(data.article, "d")! })}
    >All revisions</a
  >{#if data.entry.revision}<a
      href={resolve(`/wiki/[d]/edit?restore=${data.entry.commit.id}`, {
        d: tag(data.article, "d")!,
      })}>Restore this content</a
    >{/if}
</nav>
{#if data.entry.revision}<p>
    Editor: <code>{data.entry.revision.pubkey}</code>
  </p>
  <p>{tag(data.entry.revision, "edit_summary") ?? "No edit summary"}</p>
  <article class="prose"><RenderedArticle html={data.html ?? ""} /></article>
  <h2>Changes from the preceding Revision</h2>
  {#if data.changes}<div class="diff">
      {#each data.changes as change, index (index)}<pre
          class:added={change.added}
          class:removed={change.removed}><span class="sr-only"
            >{change.added
              ? "Added"
              : change.removed
                ? "Removed"
                : "Unchanged"}: </span><span aria-hidden="true"
            >{change.added ? "+" : change.removed ? "−" : " "}</span
          >{change.value}</pre>{/each}
    </div>{:else}<p>
      The preceding Revision is unavailable, so differences cannot be computed.
    </p>{/if}
{:else}<p>
    Historical Revision unavailable. Its content and editor signature cannot be
    verified from the Commit alone.
  </p>{/if}
