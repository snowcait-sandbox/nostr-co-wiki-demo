<script lang="ts">
  import RenderedArticle from "#lib/components/RenderedArticle.svelte";
  import { resolve } from "$app/paths";
  import { tag, title, date } from "#lib/article.ts";
  let { data }: import("./$types").PageProps = $props();
</script>

<svelte:head
  ><title>{title(data.article)} — NostrCoWiki</title><meta
    name="description"
    content={tag(data.article, "summary") ?? ""}
  /></svelte:head
>
<h1>{title(data.article)}</h1>
{#if tag(data.article, "summary")}<p class="summary">
    {tag(data.article, "summary")}
  </p>{/if}
<nav aria-label="Article">
  <a href={resolve("/wiki/[d]/edit", { d: tag(data.article, "d")! })}
    >Edit article</a
  ><a href={resolve("/wiki/[d]/history", { d: tag(data.article, "d")! })}
    >Editing history</a
  >
</nav>
<p><small>Published {date(data.article.created_at)}</small></p>
<article class="prose"><RenderedArticle html={data.html} /></article>
