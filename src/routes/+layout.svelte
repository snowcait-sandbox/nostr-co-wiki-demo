<script lang="ts">
  import { resolve } from "$app/paths";
  import type { Snippet } from "svelte";
  import "../style.css";
  let {
    children,
    data,
  }: { children: Snippet; data: import("./$types").LayoutData } = $props();
</script>

{#if !data.administration}
  <header>
    <nav aria-label="Main">
      <a href={resolve("/")}>NostrCoWiki</a><a href={resolve("/new")}
        >Create article</a
      >
    </nav>
  </header>
{/if}
<main>{@render children()}</main>
<footer>A collaboratively edited Wiki on Nostr.</footer>
