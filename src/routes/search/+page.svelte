<script lang="ts">
  import ArticleList from "#lib/components/ArticleList.svelte";
  let { data }: import("./$types").PageProps = $props();
</script>

<svelte:head><title>Search — NostrCoWiki</title></svelte:head>
<h1>Search articles</h1>
<form action="/search" method="GET" role="search">
  <label for="q">Search query</label>
  <div class="row">
    <input id="q" name="q" type="search" value={data.q} required /><button
      >Search</button
    >
  </div>
</form>
{#if data.failure}<p role="alert">{data.failure}</p>{:else if !data.q}<p>
    Enter a search query.
  </p>{:else if [...data.q].length < 3}<p>
    Use at least three characters to search articles.
  </p>{:else}<h2>Results for “{data.q}”</h2>
  {#if data.articles.length}<ArticleList articles={data.articles} />{:else}<p>
      No articles found.
    </p>{/if}{/if}
