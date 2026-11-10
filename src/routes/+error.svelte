<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
</script>

<svelte:head><title>{page.status} — NostrCoWiki</title></svelte:head>
<h1>{page.status}</h1>
<p role="alert">{page.error?.message ?? "Something went wrong."}</p>
<a href={resolve("/")}>Return to the Wiki</a>
