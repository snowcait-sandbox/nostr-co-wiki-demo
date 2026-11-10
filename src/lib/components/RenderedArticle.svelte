<script lang="ts">
  let { html }: { html: string } = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Only HTML sanitized by lib/server/render.ts reaches this shared SSR/preview sink. -->
{@html html}
