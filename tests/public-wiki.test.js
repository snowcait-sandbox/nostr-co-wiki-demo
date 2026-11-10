import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestHarness } from "wrangler";
import { chromium } from "playwright";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { normalizeIdentifier } from "../src/lib/identifier.ts";
import { renderArticle } from "../src/lib/server/render.ts";
import { createRevision, submitRevision } from "../src/lib/submission.ts";

const key = new Uint8Array(32).fill(7);
const editor = new Uint8Array(32).fill(8);
const pubkey = getPublicKey(key);
const signer = {
  getPublicKey: async () => getPublicKey(editor),
  signEvent: async (event) => finalizeEvent(event, editor),
};

test("NIP-54 normalization and sanitized Djot preserve safe links and remove XSS", () => {
  for (const [title, expected] of [
    ["  Hello  World  ", "hello-world"],
    ["What's Up?", "whats-up"],
    ["日本語 Article", "日本語-article"],
    ["Ñoño", "ñoño"],
  ]) {
    assert.equal(normalizeIdentifier(title), expected);
  }
  const html = renderArticle(
    '[Other][] [日本語][日本語 記事] [Bob][] [web][]\n\n[Bob]: nostr:npub1example\n[web]: https://example.com/\n\n[bad](javascript:alert%281%29)\n\n``` =html\n<script>attack()</script><img src="x" onerror="attack()"><a href="javascript:attack()">bad</a>\n```\n',
  );
  assert.match(html, /href="\/wiki\/other"/);
  assert.match(
    html,
    /href="\/wiki\/%E6%97%A5%E6%9C%AC%E8%AA%9E-%E8%A8%98%E4%BA%8B"/,
  );
  assert.match(html, /href="nostr:npub1example"/);
  assert.match(html, /href="https:\/\/example.com\/"/);
  assert.doesNotMatch(html, /<script|onerror=|href="javascript:/i);
});

test(
  "public Wiki browser flow uses real Workers, signing, Relay acceptance and SQLite state",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nostr-public-"));
    const webConfig = JSON.parse(await readFile("wrangler.json", "utf8"));
    const entry = join(directory, "web.js");
    await writeFile(
      entry,
      `
    import web from ${JSON.stringify(resolve(".svelte-kit/cloudflare/_worker.js"))};
    export { Wiki } from ${JSON.stringify(resolve("src/lib/server/wiki/wiki.ts"))};
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/__search') return Response.json(await env.WIKI.getByName('wiki').searchArticles(url.searchParams.get('q')));
      return web.fetch(request, env, ctx);
    }};
  `,
    );
    const options = {
      workers: [
        {
          secrets: { WIKI_PRIVATE_KEY: nsecEncode(key) },
          config: {
            ...webConfig,
            main: entry,
            assets: {
              ...webConfig.assets,
              directory: resolve(".svelte-kit/cloudflare"),
            },
          },
        },
      ],
    };
    const server = createTestHarness(options);
    let browser;
    t.after(async () => {
      try {
        await browser?.close();
        await server.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    const { url } = await server.listen();
    const base = url.origin;
    assert.match(
      await (
        await server
          .getWorker("nostr-co-wiki")
          .fetch("https://wiki.example:8443/new")
      ).text(),
      /wss:\/\/wiki\.example:8443\/relay/,
    );
    const relayUrl = base.replace(/^http/, "ws") + "/relay";
    assert.equal((await fetch(base + "/new")).status, 200);
    const db = await server
      .getWorker("nostr-co-wiki")
      .getDurableObjectStorage("Wiki", { name: "wiki" });
    const request = (path, options = {}) =>
      fetch(base + path, {
        ...options,
        headers: { "CF-Connecting-IP": "203.0.113.42", ...options.headers },
      });
    const info = async (d) =>
      (await request("/api/article?d=" + encodeURIComponent(d))).json();
    const publish = (d, content, articleBase, title = d) =>
      submitRevision(
        signer,
        relayUrl,
        createRevision({
          d,
          title,
          content,
          summary: "",
          editSummary: "Server-side editor",
          base: articleBase,
          wikiPubkey: pubkey,
        }),
      );
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.42" },
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const failures = [];
    page.on("websocket", (socket) => assert.equal(socket.url(), relayUrl));
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(base);
    assert.match(await page.content(), /No published articles yet/);
    await page.getByRole("link", { name: "Create article" }).first().click();
    await page.getByLabel("Title (required)").fill("Draft");
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and submit Revision" })
        .isDisabled(),
      true,
    );
    assert.match(
      await page.content(),
      /Waiting for a NIP-07 compatible signing extension/,
    );
    await page
      .getByText("This identifier is available.", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and submit Revision" })
        .isDisabled(),
      true,
    );
    await page.getByRole("link", { name: "NostrCoWiki" }).first().click();
    await page.getByRole("link", { name: "Create article" }).first().click();
    await page.getByLabel("Title (required)").fill("Draft");
    await page
      .getByText("This identifier is available.", { exact: false })
      .waitFor();
    await page.waitForTimeout(3200);
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and submit Revision" })
        .isDisabled(),
      true,
    );
    await page.exposeFunction("signForTest", signer.signEvent);
    await page.evaluate(() => {
      globalThis.nostr = {
        getPublicKey: async () => "",
        signEvent: (event) => globalThis.signForTest(event),
      };
    });
    await page.waitForFunction(
      () =>
        globalThis.document.querySelector("form button")?.disabled === false,
    );
    await page.addInitScript(() => {
      globalThis.nostr = {
        getPublicKey: async () => "",
        signEvent: (event) => globalThis.signForTest(event),
      };
    });
    await page.getByLabel("Title (required)").fill("日本語 Article");
    await page.getByLabel("Djot source").fill("First source\n\n[Other][]");
    await page
      .getByLabel("Summary (optional)", { exact: true })
      .fill("Japanese summary");
    await page.getByLabel("Edit summary (optional)").fill("Create article");
    await page.getByLabel("Title (required)").fill("Temporary title");
    await page.getByLabel("Title (required)").fill("日本語 Article");
    assert.equal(
      await page.getByLabel("Djot source").inputValue(),
      "First source\n\n[Other][]",
    );
    assert.equal(
      await page.getByLabel("Summary (optional)", { exact: true }).inputValue(),
      "Japanese summary",
    );
    assert.equal(
      await page.getByLabel("Edit summary (optional)").inputValue(),
      "Create article",
    );
    await page
      .getByText("This identifier is available.", { exact: false })
      .waitFor();
    await page.getByRole("link", { name: "Other", exact: true }).waitFor();
    let publicationChecks = 0;
    await page.route("**/api/article?**", async (route) => {
      if (
        new URL(route.request().url()).searchParams.has("revision") &&
        ++publicationChecks <= 2
      ) {
        const response = await route.fetch();
        const state = await response.json();
        await route.fulfill({ json: { ...state, reflectsRevision: false } });
      } else {
        await route.continue();
      }
    });
    await page
      .getByRole("button", { name: "Sign and submit Revision" })
      .click();
    await page.waitForURL(/\/wiki\//);
    assert.ok(
      publicationChecks >= 3,
      "navigation must wait for confirmed publication",
    );
    const d = "日本語-article";
    const articlePath = "/wiki/" + encodeURIComponent(d);
    const first = (await info(d)).article;
    assert.ok(first);
    assert.equal(first.pubkey, pubkey);
    const firstCommit = first.tags.find((tag) => tag[0] === "head")[1];
    const ssr = await (await request(articlePath)).text();
    assert.match(ssr, /First source/);
    assert.match(ssr, /Japanese summary/);
    assert.match(ssr, /href="\/wiki\/other"/);
    assert.doesNotMatch(ssr, /nsec1|WIKI_PRIVATE_KEY|Admin dashboard/);
    await page.goto(base + "/new");
    await page.getByLabel("Title (required)").fill("日本語 Article");
    await page
      .getByText("This article already exists.", { exact: false })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and submit Revision" })
        .isDisabled(),
      true,
    );
    await page.goto(base + articlePath + "/edit");
    await page.getByLabel("Title (required)").fill("Renamed title");
    await page.getByLabel("Djot source").fill("My preserved edit\n");
    await page.evaluate(() => {
      globalThis.nostr.signEvent = async () => {
        throw new Error("Declined");
      };
    });
    await page
      .getByRole("button", { name: "Sign and submit Revision" })
      .click();
    await page.getByText("Signing was declined", { exact: false }).waitFor();
    assert.equal(
      await page.getByLabel("Djot source").inputValue(),
      "My preserved edit\n",
    );
    await page.evaluate(() => {
      globalThis.nostr.signEvent = (event) => globalThis.signForTest(event);
    });
    assert.equal(
      (await publish(d, "Another editor's update\n", firstCommit))["type"],
      "accepted",
    );
    await page
      .getByRole("button", { name: "Sign and submit Revision" })
      .click();
    await page
      .getByRole("heading", { name: "Resolve the edit conflict" })
      .waitFor();
    await page
      .getByRole("button", { name: "Use this Commit as base" })
      .waitFor();
    assert.equal(
      await page.getByLabel("Djot source").inputValue(),
      "My preserved edit\n",
    );
    await page.getByRole("button", { name: "Use this Commit as base" }).click();
    await page
      .getByRole("button", { name: "Sign and submit Revision" })
      .click();
    await page.waitForURL(base + articlePath);
    await page
      .getByRole("heading", { name: "Renamed title", exact: true })
      .waitFor();
    assert.match(await page.content(), /Renamed title/);
    assert.match(await page.content(), /My preserved edit/);
    await page.getByRole("link", { name: "Editing history" }).click();
    await page.getByRole("link", { name: "Revision 1", exact: true }).click();
    assert.match(await page.content(), /First source/);
    await page.locator(".diff .added").first().waitFor();
    await page.getByRole("link", { name: "Restore this content" }).click();
    assert.equal(
      await page.getByLabel("Djot source").inputValue(),
      first.content,
    );
    const restoreBase = (await info(d)).article.tags.find(
      (tag) => tag[0] === "head",
    )[1];
    assert.equal(
      (await publish(d, "A newer edit during restoration", restoreBase)).type,
      "accepted",
    );
    await page
      .getByRole("button", { name: "Sign and submit Revision" })
      .click();
    await page
      .getByRole("button", { name: "Use this Commit as base" })
      .waitFor();
    assert.equal(
      await page.getByLabel("Djot source").inputValue(),
      first.content,
    );
    await page.getByRole("button", { name: "Use this Commit as base" }).click();
    await page
      .getByRole("button", { name: "Sign and submit Revision" })
      .click();
    await page.waitForURL(base + articlePath);
    assert.match(await page.content(), /First source/);
    const history = await db.exec(
      "SELECT data FROM events WHERE kind = 3818 AND article_d = ? ORDER BY seq",
      d,
    );
    assert.equal(history.length, 5);
    assert.equal(JSON.parse(history[0].data).id, firstCommit);
    const restoredRevision = JSON.parse(
      (
        await db.exec(
          "SELECT data FROM events WHERE id = ?",
          Buffer.from(
            JSON.parse(history.at(-1).data).tags.find(
              (tag) => tag[0] === "e",
            )[1],
            "hex",
          ),
        )
      )[0].data,
    );
    assert.equal(restoredRevision.content, first.content);
    assert.equal(
      restoredRevision.tags.find((tag) => tag[0] === "e")[1],
      JSON.parse(history.at(-2).data).id,
    );
    // Differencing must show both removals and additions for the second Revision.
    const secondCommit = JSON.parse(history[1].data).id;
    const diffHtml = await (
      await request(articlePath + "/history/" + secondCommit)
    ).text();
    assert.match(diffHtml, /class="removed"|class="removed /);
    assert.match(diffHtml, /class="added"|class="added /);
    assert.equal((await publish("ranking", "exact match")).type, "accepted");
    assert.equal(
      (await publish("ranking-guide", "partial match")).type,
      "accepted",
    );
    const links = (html) =>
      [...html.matchAll(/href="([^"]*)"/g)].map(
        (match) => new URL(match[1], base + "/search").pathname,
      );
    const search = await (await request("/search?q=ranking")).text();
    const searchLinks = links(search);
    assert.ok(searchLinks.includes("/wiki/ranking"), search);
    assert.ok(
      searchLinks.indexOf("/wiki/ranking") <
        searchLinks.indexOf("/wiki/ranking-guide"),
    );
    const rpcSearch = async (q) =>
      (await request("/__search?q=" + encodeURIComponent(q))).json();
    const ranked = await rpcSearch("ranking");
    assert.deepEqual(
      ranked.map((event) => event.tags.find((tag) => tag[0] === "d")[1]),
      ["ranking", "ranking-guide"],
    );
    assert.ok(
      ranked.every((event) => event.kind === 30818 && event.pubkey === pubkey),
    );
    assert.deepEqual(await rpcSearch("日"), []);
    const home = await (await request("/")).text();
    const published = (
      await db.exec("SELECT data FROM events WHERE kind = 30818")
    ).map((row) => JSON.parse(row.data));
    published.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
    assert.deepEqual(
      links(home).filter((path) => path.startsWith("/wiki/")),
      published.map(
        (event) =>
          "/wiki/" +
          encodeURIComponent(event.tags.find((tag) => tag[0] === "d")[1]),
      ),
    );
    // Hiding uses the existing DB state solely as a test fixture, not an admin API.
    await db.exec("UPDATE articles SET is_published = 0 WHERE d = 'ranking'");
    const hidden = await info("ranking");
    assert.deepEqual(hidden, {
      status: "unpublished",
      article: null,
      reflectsRevision: false,
    });
    assert.equal((await request("/wiki/ranking")).status, 404);
    assert.equal((await request("/wiki/ranking/history")).status, 404);
    assert.equal((await request("/wiki/ranking/edit")).status, 404);
    assert.equal(
      links(await (await request("/search?q=ranking")).text()).includes(
        "/wiki/ranking",
      ),
      false,
    );
    assert.ok(
      !(await rpcSearch("ranking")).some((event) =>
        event.tags.some((tag) => tag[0] === "d" && tag[1] === "ranking"),
      ),
    );
    await page.goto(base + "/new");
    await page.getByLabel("Title (required)").fill("Ranking");
    await page.getByText("This URL is unavailable.").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Sign and submit Revision" })
        .isDisabled(),
      true,
    );
    assert.equal(await page.locator('a[href="/wiki/ranking"]').count(), 0);
    const rejected = await publish("ranking", "not allowed");
    assert.equal(rejected.type, "rejected");
    const connectionFailure = await submitRevision(
      signer,
      "ws://127.0.0.1:1",
      createRevision({
        d: "offline",
        title: "Offline",
        summary: "",
        editSummary: "",
        content: "draft",
        wikiPubkey: pubkey,
      }),
    );
    assert.equal(connectionFailure.type, "connection");
    const missingId = restoredRevision.id;
    await db.exec(
      "DELETE FROM events WHERE id = ?",
      Buffer.from(missingId, "hex"),
    );
    assert.match(
      await (
        await request(
          articlePath + "/history/" + JSON.parse(history.at(-1).data).id,
        )
      ).text(),
      /Historical Revision unavailable/,
    );
    assert.equal(
      (
        await request(
          articlePath + "/edit?restore=" + JSON.parse(history.at(-1).data).id,
        )
      ).status,
      404,
    );
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
      true,
    );
    for (let i = 0; i < 54; i++) {
      const d = "rpc-limit-" + i;
      const event = finalizeEvent(
        {
          kind: i === 52 ? 2818 : 30818,
          created_at: 1000 + i,
          content: "rpc-limit",
          tags: [["d", d]],
        },
        i === 51 ? editor : key,
      );
      const id = Buffer.from(event.id, "hex");
      await db.exec(
        "INSERT INTO events (id, kind, pubkey, created_at, article_d, data) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        event.kind,
        Buffer.from(event.pubkey, "hex"),
        event.created_at,
        d,
        JSON.stringify(event),
      );
      const rows = await db.exec(
        "INSERT INTO articles (d, head_commit_id, published_event_id, is_published) VALUES (?, ?, ?, 1) RETURNING id",
        d,
        id,
        id,
      );
      await db.exec(
        "INSERT INTO article_fts (rowid, d, title, summary, content) VALUES (?, ?, ?, '', ?)",
        rows[0].id,
        d,
        d,
        event.content,
      );
    }
    const limited = await rpcSearch("rpc-limit");
    assert.equal(limited.length, 50);
    assert.ok(
      limited.every((event) => event.kind === 30818 && event.pubkey === pubkey),
    );
    assert.deepEqual(failures, []);
  },
);
