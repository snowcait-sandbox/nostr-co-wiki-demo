<script lang="ts">
  import { resolve } from "$app/paths";
  import ArticleList from "#lib/components/ArticleList.svelte";
  let { data }: import("./$types").PageProps = $props();
</script>

<svelte:head><title>NostrCoWiki</title></svelte:head>
<h1>NostrCoWiki</h1>
<p>Read, write, and improve a shared Wiki.</p>
<form action="/search" method="GET" role="search">
  <label for="search">Search articles</label>
  <div class="row">
    <input id="search" name="q" type="search" required /><button>Search</button>
  </div>
</form>
<h2>Recently updated articles</h2>
{#if data.articles.length}<ArticleList
    articles={data.articles}
    showDate
  />{:else}<p>
    No published articles yet. <a href={resolve("/new")}
      >Create the first article</a
    >.
  </p>{/if}
