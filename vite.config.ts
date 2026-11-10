import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The adapter writes to main. Keep its output separate from our Worker entry.
const config = JSON.parse(readFileSync("wrangler.json", "utf8"));
mkdirSync(".svelte-kit", { recursive: true });
const adapterConfig = ".svelte-kit/adapter-wrangler.json";
writeFileSync(
  adapterConfig,
  JSON.stringify({
    ...config,
    main: resolve(".svelte-kit/cloudflare/_worker.js"),
    assets: { ...config.assets, directory: resolve(config.assets.directory) },
  }),
);
export default defineConfig({
  plugins: [sveltekit({ adapter: adapter({ config: adapterConfig }) })],
});
