import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { nsecEncode } from "nostr-tools/nip19";

test(
  "Single Worker serves SSR and binds its SQLite Wiki Durable Object",
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nostr-co-wiki-"));
    let child;
    let stopped;
    let spawnError;
    t.after(async () => {
      try {
        if (
          child &&
          child.exitCode === null &&
          child.signalCode === null &&
          !spawnError
        ) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") {
              throw error;
            }
          }
          await stopped;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const config = JSON.parse(await readFile("wrangler.json", "utf8"));
    assert.deepEqual(config.exports.Wiki, {
      type: "durable-object",
      storage: "sqlite",
    });
    assert.equal(config.durable_objects.bindings[0].script_name, undefined);
    await writeFile(
      join(directory, "wrangler.json"),
      JSON.stringify({
        ...config,
        main: resolve("worker.js"),
        assets: {
          ...config.assets,
          directory: resolve(".svelte-kit/cloudflare"),
        },
      }),
    );
    await writeFile(
      join(directory, ".dev.vars"),
      "WIKI_PRIVATE_KEY=" + nsecEncode(new Uint8Array(32).fill(9)) + "\n",
    );
    let output = "";
    child = spawn(
      resolve("node_modules/.bin/wrangler"),
      [
        "dev",
        "-c",
        join(directory, "wrangler.json"),
        "--port",
        "18787",
        "--persist-to",
        join(directory, "state"),
        "--inspector-port",
        "0",
      ],
      {
        detached: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    stopped = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", (error) => {
        spawnError = error;
        resolve();
      });
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    let response;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(output);
      }
      try {
        response = await fetch("http://localhost:18787/");
        break;
      } catch {
        await setTimeout(500);
      }
    }
    assert.ok(response, output);
    assert.equal(response.status, 200, output);
    const html = await response.text();
    assert.match(html, /<h1>NostrCoWiki<\/h1>/);
    assert.equal((await fetch("http://localhost:18787/relay")).status, 426);
  },
);
