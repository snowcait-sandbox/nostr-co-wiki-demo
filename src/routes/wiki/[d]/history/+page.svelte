<script lang="ts">
  import { resolve } from "$app/paths";
  import { tag, title, date } from "#lib/article.ts";
  let { data }: import("./$types").PageProps = $props();
</script>

<svelte:head
  ><title>History of {title(data.article)} — NostrCoWiki</title></svelte:head
>
<h1>History of {title(data.article)}</h1>
<a href={resolve("/wiki/[d]", { d: tag(data.article, "d")! })}>Read article</a>
<ol class="history">
  {#each data.history as entry (entry.commit.id)}<li>
      <a
        href={resolve("/wiki/[d]/history/[commit]", {
          d: tag(data.article, "d")!,
          commit: entry.commit.id,
        })}>Revision {tag(entry.commit, "seq")}</a
      >
      — {date(entry.commit.created_at)}
      {#if entry.revision}<p>Editor: <code>{entry.revision.pubkey}</code></p>
        <p>
          {tag(entry.revision, "edit_summary") ?? "No edit summary"}
        </p>{:else}<p>
          Historical Revision unavailable; its content and editor signature
          cannot be verified.
        </p>{/if}
    </li>{/each}
</ol>
