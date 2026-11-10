<script lang="ts">
  import Editor from "#lib/components/Editor.svelte";
  let { data }: import("./$types").PageProps = $props();
</script>

<svelte:head><title>Edit {data.title} — NostrCoWiki</title></svelte:head>
<h1>Edit {data.title}</h1>
{#key data.d + (data.restored ?? "")}<Editor {data} />{/key}
