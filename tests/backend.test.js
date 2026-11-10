import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createTestHarness } from "wrangler";
import {
  finalizeEvent,
  getPublicKey,
  verifiedSymbol,
  verifyEvent,
} from "nostr-tools/pure";
import { matches, signedEvent } from "../src/lib/server/wiki/protocol.ts";
import { nsecEncode } from "nostr-tools/nip19";

const wikiKey = new Uint8Array(32).fill(1);
const editorKey = new Uint8Array(32).fill(2);
const wikiPubkey = getPublicKey(wikiKey);

function revision(
  d,
  base,
  content = "Article content",
  tags = [],
  key = editorKey,
) {
  return finalizeEvent(
    {
      kind: 2818,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [
        ["a", `30818:${wikiPubkey}:${d}`],
        ...(base ? [["e", base]] : []),
        ...tags,
      ],
    },
    key,
  );
}

async function connection(worker, t) {
  const response = await worker.fetch("http://relay.test/relay", {
    headers: {
      Upgrade: "websocket",
      "CF-Connecting-IP": "203.0.113.9",
    },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  t.after(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  });
  const inbox = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      inbox.push(message);
    } else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    socket,
    inbox,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    next(predicate) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) {
        return Promise.resolve(inbox.splice(index, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(
              new Error(
                `Timed out waiting for a relay message; inbox=${JSON.stringify(inbox)}`,
              ),
            );
          }, 10000),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function publish(client, event) {
  client.send(["EVENT", event]);
  return client.next(
    (message) => message[0] === "OK" && message[1] === event.id,
  );
}

let queryId = 0;
async function query(client, ...filters) {
  const id = `query-${queryId++}`;
  client.send(["REQ", id, ...filters]);
  const events = [];
  for (;;) {
    const message = await client.next((message) => message[1] === id);
    assert.notEqual(message[0], "CLOSED", JSON.stringify(message));
    if (message[0] === "EOSE") {
      break;
    }
    assert.equal(message[0], "EVENT");
    events.push(message[2]);
  }
  client.send(["CLOSE", id]);
  return events;
}

function verify(event) {
  // JSON removes the library's cached verification marker.
  assert.equal(verifyEvent(JSON.parse(JSON.stringify(event))), true);
}

function tag(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

test("protocol matching preserves zero time bounds and search constraints", () => {
  const zero = finalizeEvent(
    { kind: 30818, created_at: 0, content: "Nostr", tags: [] },
    editorKey,
  );
  const later = finalizeEvent(
    { kind: 30818, created_at: 1, content: "Nostr", tags: [] },
    editorKey,
  );
  const filter = {
    authors: [zero.pubkey],
    since: 0,
    until: 0,
    search: "nostr",
  };
  assert.equal(matches(zero, filter), true);
  assert.equal(matches(later, filter), false);
  assert.equal(matches(later, { since: 0, search: "nostr" }), true);
  assert.equal(matches(later, { since: 1, until: 1, search: "nostr" }), true);
  assert.equal(matches(later, { since: 2 }), false);
  assert.equal(matches(zero, { ...filter, authors: [wikiPubkey] }), false);
  assert.equal(matches(zero, { ...filter, search: "missing" }), false);
});

test("event validation rejects malformed fields and never trusts an incoming verification cache", () => {
  const valid = revision("validation");
  const input = { ...valid, extra: "ignored", [verifiedSymbol]: false };
  const accepted = signedEvent(input);
  assert.notEqual(accepted, input);
  assert.equal(verifyEvent(accepted), true);
  assert.deepEqual(Object.keys(accepted).sort(), [
    "content",
    "created_at",
    "id",
    "kind",
    "pubkey",
    "sig",
    "tags",
  ]);
  assert.throws(
    () => signedEvent({ ...valid, content: "tampered" }),
    /invalid: event ID or signature/,
  );
  for (const fields of [
    { kind: -1 },
    { kind: 2818.5 },
    { kind: 65536 },
    { created_at: -1 },
    { created_at: 0.5 },
    { created_at: Number.MAX_SAFE_INTEGER + 1 },
    { tags: [[]] },
    { tags: [["a", null]] },
    { tags: "invalid" },
    { content: 1 },
    { pubkey: 123 },
    { id: valid.id.toUpperCase() },
    { sig: "A".repeat(128) },
  ]) {
    assert.throws(
      () => signedEvent({ ...valid, ...fields }),
      /invalid: malformed event/,
    );
  }
});

test(
  "Wiki backend on Workers and SQLite Durable Objects",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nostr-co-wiki-backend-"));
    const webConfig = JSON.parse(await readFile("wrangler.json", "utf8"));
    const webProbe = join(directory, "web-probe.js");
    await writeFile(
      webProbe,
      `
      import web from ${JSON.stringify(resolve(".svelte-kit/cloudflare/_worker.js"))};
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          const wiki = env.WIKI.getByName("wiki");
          if (url.pathname === "/__alarm") {
            if (request.method === "POST") await wiki.triggerCleanup(url.searchParams.has("fail"));
            return Response.json(await wiki.alarmState());
          }
          if (url.pathname === "/__fail-alarm") {
            await wiki.failNextAlarmReservation(0, url.searchParams.get("method") ?? "setAlarm");
            return new Response(null, { status: 204 });
          }
          if (url.pathname === "/__socket-error") {
            await wiki.disconnectWithError();
            return new Response(null, { status: 204 });
          }
          if (url.pathname === "/__subscriptions") return Response.json(await wiki.subscriptionState());
          if (url.pathname === "/__query") {
            try { return Response.json(await wiki.queryUnchecked(await request.json())); }
            catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
          }
          if (url.pathname === "/__article") return Response.json(await wiki.getArticle(url.searchParams.get("d")));
          if (url.pathname === "/__history") return Response.json(await wiki.getHistory(url.searchParams.get("d")));
          return web.fetch(request, env, ctx);
        }
      };

      import { Wiki as BackendWiki } from ${JSON.stringify(resolve("src/lib/server/wiki/wiki.ts"))};
      import { queryEvents } from ${JSON.stringify(resolve("src/lib/server/wiki/query.ts"))};
      export class Wiki extends BackendWiki {
        alarmRuns = 0;
        failedCleanupKeys = null;
        async alarm() {
          try {
            await super.alarm();
            this.alarmRuns++;
          } catch (error) {
            this.failedCleanupKeys = this.subscriptionState().map(([key]) => key);
            throw error;
          }
        }
        async alarmState() {
          return { scheduled: await this.ctx.storage.getAlarm(), runs: this.alarmRuns, failedCleanupKeys: this.failedCleanupKeys };
        }
        async triggerCleanup(failReservation) {
          if (failReservation) this.failNextAlarmReservation(1);
          await this.ctx.storage.setAlarm(Date.now());
        }
        failNextAlarmReservation(skip = 0, method = "setAlarm") {
          const original = this.ctx.storage[method];
          this.ctx.storage[method] = (...args) => {
            if (skip-- > 0) return original.apply(this.ctx.storage, args);
            this.ctx.storage[method] = original;
            throw new Error("Injected Alarm reservation failure");
          };
        }
        disconnectWithError() {
          for (const socket of this.ctx.getWebSockets()) {
            const { id } = socket.deserializeAttachment();
            const subscriptions = this.ctx.storage.kv.get("subscriptions:" + id) ?? [];
            if (subscriptions.some(sub => sub.id === "socket-error")) this.webSocketError(socket);
          }
        }
        subscriptionState() {
          return Array.from(this.ctx.storage.kv.list({ prefix: "subscriptions:" }));
        }
        queryUnchecked(filters) {
          return queryEvents(this.ctx.storage.sql, filters);
        }
      }
`,
    );
    const server = createTestHarness({
      workers: [
        {
          secrets: { WIKI_PRIVATE_KEY: nsecEncode(wikiKey) },
          config: {
            ...webConfig,
            main: webProbe,
            assets: {
              ...webConfig.assets,
              directory: resolve(".svelte-kit/cloudflare"),
            },
          },
        },
      ],
    });
    t.after(async () => {
      try {
        await server.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    await server.listen();
    const relay = server.getWorker("nostr-co-wiki");
    const web = server.getWorker("nostr-co-wiki");
    const wiki = {
      async alarmState() {
        return (await web.fetch("/__alarm")).json();
      },
      async triggerCleanup(failReservation = false) {
        const before = await this.alarmState();
        await web.fetch(failReservation ? "/__alarm?fail" : "/__alarm", {
          method: "POST",
        });
        for (let attempt = 0; attempt < 1000; attempt++) {
          const state = await this.alarmState();
          if (state.runs > before.runs) {
            return state;
          }
          await delay(10);
        }
        assert.fail("Alarm handler did not complete");
      },
      async subscriptionState() {
        return (await web.fetch("/__subscriptions")).json();
      },
      async getArticle(d) {
        return (
          await web.fetch(`/__article?d=${encodeURIComponent(d)}`)
        ).json();
      },
      async getHistory(d) {
        return (
          await web.fetch(`/__history?d=${encodeURIComponent(d)}`)
        ).json();
      },
    };
    const db = await relay.getDurableObjectStorage("Wiki", { name: "wiki" });
    const client = await connection(relay, t);
    let first;
    let firstArticle;
    let second;
    let secondArticle;

    await t.test(
      "initializes the specified schema and preserves the existing SSR/binding",
      async () => {
        assert.match(
          await (await web.fetch("/")).text(),
          /<h1>NostrCoWiki<\/h1>/,
        );
        assert.equal(await wiki.getArticle("missing"), null);
        assert.deepEqual(await wiki.getHistory("missing"), []);
        const tables = await db.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        );
        for (const name of [
          "events",
          "articles",
          "article_fts",
          "event_receipts",
        ]) {
          assert.ok(tables.some((row) => row.name === name));
        }
        const indexes = await db.exec(
          "SELECT name FROM sqlite_master WHERE type = 'index'",
        );
        for (const name of [
          "events_article_history",
          "events_commit_revision",
          "events_kind_time",
        ]) {
          assert.ok(indexes.some((row) => row.name === name));
        }
        assert.equal(
          (await db.exec("PRAGMA table_info(events)")).find(
            (row) => row.name === "id",
          ).notnull,
          1,
        );
        await assert.rejects(db.exec("INSERT INTO events (id) VALUES (NULL)"));
        assert.equal(
          (
            await relay.fetch("http://relay.test/not-the-relay", {
              headers: { Upgrade: "websocket" },
            })
          ).status,
          404,
        );
      },
    );

    await t.test(
      "keeps subscriptions when Alarm reservation fails and does not extend an existing deadline",
      async () => {
        const day = 24 * 60 * 60 * 1000;
        assert.equal((await wiki.alarmState()).scheduled, null);
        const failedIds = [];
        for (const method of ["getAlarm", "setAlarm"]) {
          await web.fetch(`/__fail-alarm?method=${method}`, { method: "POST" });
          const id = `alarm-failed-${method}`;
          client.send(["REQ", id, { kinds: [2818], limit: 0 }]);
          assert.equal(
            (await client.next((message) => message[0] === "EOSE"))[1],
            id,
          );
          failedIds.push(id);
          assert.deepEqual(
            (await wiki.subscriptionState())[0][1].map((sub) => sub.id),
            failedIds,
          );
          assert.equal((await wiki.alarmState()).scheduled, null);
        }
        const before = Date.now();
        client.send(["REQ", "alarm-first", { kinds: [2818], limit: 0 }]);
        await client.next((message) => message[0] === "EOSE");
        const scheduled = (await wiki.alarmState()).scheduled;
        assert.ok(scheduled >= before + day && scheduled <= Date.now() + day);
        for (const id of ["alarm-first", "alarm-second", "alarm-third"]) {
          client.send(["REQ", id, { kinds: [2818], limit: 0 }]);
        }
        for (let i = 0; i < 3; i++) {
          await client.next((message) => message[0] === "EOSE");
        }
        assert.equal((await wiki.alarmState()).scheduled, scheduled);
        assert.deepEqual(
          (await wiki.subscriptionState())[0][1].map((sub) => sub.id),
          [...failedIds, "alarm-first", "alarm-second", "alarm-third"],
        );
        for (const id of [
          ...failedIds,
          "alarm-first",
          "alarm-second",
          "alarm-third",
        ]) {
          client.send(["CLOSE", id]);
        }
        // A subsequent request is a barrier after all CLOSE messages.
        client.send(["UNKNOWN"]);
        await client.next((message) => message[0] === "NOTICE");
        assert.deepEqual(await wiki.subscriptionState(), []);
        // Let the one pending Alarm observe the empty state and stop.
        assert.equal((await wiki.triggerCleanup()).scheduled, null);
      },
    );

    await t.test(
      "accepts a native WebSocket client at the Relay endpoint",
      async () => {
        const url = new URL((await server.listen()).url);
        url.protocol = "ws:";
        url.pathname = "/relay";
        const native = new WebSocket(url);
        let timeout;
        try {
          await new Promise((resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Native WebSocket timed out")),
              10000,
            );
            native.addEventListener("open", () =>
              native.send(JSON.stringify(["REQ", "native", { limit: 0 }])),
            );
            native.addEventListener("error", () =>
              reject(new Error("Native WebSocket connection failed")),
            );
            native.addEventListener("message", (event) => {
              assert.deepEqual(JSON.parse(event.data), ["EOSE", "native"]);
              resolve();
            });
          });
        } finally {
          clearTimeout(timeout);
          native.close();
        }
      },
    );

    await t.test(
      "rejects malformed messages, filters, signatures, IDs, and invalid Revisions",
      async () => {
        client.socket.send("{");
        assert.equal(
          (await client.next((message) => message[0] === "NOTICE"))[0],
          "NOTICE",
        );
        client.socket.send(new Uint8Array([1, 2]));
        await client.next((message) => message[0] === "NOTICE");
        client.send(["UNKNOWN"]);
        await client.next((message) => message[0] === "NOTICE");
        for (const filter of [
          { kinds: "2818" },
          { authors: ["short"] },
          { limit: -1 },
          { since: 1.2 },
          { "#e": ["wrong"] },
          { search: 1 },
          { unknown: true },
        ]) {
          client.send(["REQ", "invalid", filter]);
          assert.equal(
            (await client.next((message) => message[0] === "CLOSED"))[1],
            "invalid",
          );
        }
        const valid = revision("valid");
        const invalid = [
          { ...valid, content: "tampered" },
          { ...valid, sig: "0".repeat(128) },
          { ...valid, id: "0".repeat(64) },
          { ...valid, tags: [["a", 123]] },
          finalizeEvent(
            { kind: 1, created_at: 1, content: "", tags: [] },
            editorKey,
          ),
          revision("Uppercase"),
          revision("bad identifier"),
          revision(""),
          revision("duplicate-tags", undefined, "", [
            ["title", "a"],
            ["title", "b"],
          ]),
          revision("missing-value", undefined, "", [["summary"]]),
          revision("bad-base", "not-an-id"),
          finalizeEvent(
            {
              kind: 2818,
              created_at: 1,
              content: "",
              tags: [["a", `30818:${getPublicKey(editorKey)}:wrong-wiki`]],
            },
            editorKey,
          ),
          revision("duplicate-address", undefined, "", [
            ["a", `30818:${wikiPubkey}:duplicate-address`],
          ]),
          finalizeEvent(
            { kind: 2818, created_at: 1, content: "", tags: [] },
            editorKey,
          ),
          finalizeEvent(
            {
              kind: 2818,
              created_at: -1,
              content: "",
              tags: [["a", `30818:${wikiPubkey}:negative`]],
            },
            editorKey,
          ),
        ];
        for (const event of invalid) {
          const result = await publish(client, event);
          assert.equal(result[2], false, JSON.stringify(event));
          assert.match(
            result[3],
            event.kind === 2818 ? /^invalid:/ : /^blocked:/,
          );
        }
        assert.deepEqual(await query(client, {}), []);
        assert.equal(
          (await db.exec("SELECT count(*) AS n FROM events"))[0].n,
          0,
        );
      },
    );

    await t.test(
      "accepts a new Revision, signs Wiki events, and records the originating IP",
      async () => {
        first = revision("nostr", undefined, "Nostr is an open protocol.", [
          ["title", "Nostr"],
          ["summary", "A protocol overview"],
          ["edit_summary", "Initial article"],
        ]);
        assert.equal((await publish(client, first))[2], true);
        firstArticle = await wiki.getArticle("nostr");
        const history = await wiki.getHistory("nostr");
        assert.equal(history.length, 1);
        const commit = history[0].commit;
        assert.equal(commit.kind, 3818);
        assert.equal(commit.content, "");
        assert.equal(commit.pubkey, wikiPubkey);
        assert.equal(tag(commit, "seq"), "1");
        assert.equal(tag(commit, "prev"), undefined);
        assert.equal(tag(commit, "e"), first.id);
        assert.equal(tag(commit, "a"), `30818:${wikiPubkey}:nostr`);
        assert.equal(firstArticle.kind, 30818);
        assert.equal(firstArticle.pubkey, wikiPubkey);
        assert.equal(tag(firstArticle, "head"), commit.id);
        assert.equal(firstArticle.content, first.content);
        assert.equal(tag(firstArticle, "title"), "Nostr");
        assert.equal(tag(firstArticle, "summary"), "A protocol overview");
        for (const event of [first, commit, firstArticle]) {
          verify(event);
        }
        assert.equal(history[0].revision.id, first.id);
        const receipts = await db.exec(
          "SELECT lower(hex(revision_id)) AS id, ip_address, received_at FROM event_receipts",
        );
        assert.deepEqual(receipts, [
          {
            id: first.id,
            ip_address: "203.0.113.9",
            received_at: commit.created_at,
          },
        ]);
        assert.deepEqual(
          await db.exec(
            "SELECT DISTINCT length(id) AS id_len, length(pubkey) AS pubkey_len FROM events",
          ),
          [{ id_len: 32, pubkey_len: 32 }],
        );
      },
    );

    await t.test(
      "resubmission is idempotent and constraints enforce one Commit per Revision and sequence",
      async () => {
        const before = await db.exec("SELECT * FROM event_receipts");
        const results = await Promise.all([
          publish(client, first),
          publish(await connection(relay, t), first),
        ]);
        assert.ok(
          results.every(
            (message) =>
              message[2] === true && message[3].startsWith("duplicate:"),
          ),
        );
        assert.deepEqual(await db.exec("SELECT * FROM event_receipts"), before);
        assert.equal((await wiki.getHistory("nostr")).length, 1);
        await assert.rejects(
          db.exec("INSERT INTO event_receipts SELECT * FROM event_receipts"),
        );
        await assert.rejects(
          db.exec("INSERT INTO events SELECT * FROM events"),
        );
        await assert.rejects(
          db.exec(
            "INSERT INTO articles (d, head_commit_id, published_event_id, is_published) SELECT d, head_commit_id, published_event_id, is_published FROM articles",
          ),
        );
        await assert.rejects(
          db.exec(`INSERT INTO events (id, kind, pubkey, created_at, article_d, ref_event_id, seq, data)
      SELECT randomblob(32), kind, pubkey, created_at, article_d, ref_event_id, seq + 1, data FROM events WHERE kind = 3818`),
        );
        await assert.rejects(
          db.exec(`INSERT INTO events (id, kind, pubkey, created_at, article_d, ref_event_id, seq, data)
      SELECT randomblob(32), kind, pubkey, created_at, article_d, randomblob(32), seq, data FROM events WHERE kind = 3818`),
        );
      },
    );

    await t.test(
      "updates atomically with strictly increasing Article timestamps and detects racing edits",
      async () => {
        const base = tag(firstArticle, "head");
        second = revision("nostr", base, "The current Nostr article.", [
          ["edit_summary", "Update"],
        ]);
        assert.equal((await publish(client, second))[2], true);
        secondArticle = await wiki.getArticle("nostr");
        assert.ok(secondArticle.created_at > firstArticle.created_at);
        assert.ok(secondArticle.created_at <= Math.floor(Date.now() / 1000));
        assert.equal(tag(secondArticle, "title"), undefined);
        assert.equal(tag(secondArticle, "summary"), undefined);
        const history = await wiki.getHistory("nostr");
        assert.equal(history.length, 2);
        assert.equal(tag(history[1].commit, "seq"), "2");
        assert.equal(tag(history[1].commit, "prev"), history[0].commit.id);
        verify(history[1].commit);
        verify(secondArticle);
        assert.equal(
          (await publish(client, revision("nostr", base, "stale edit")))[2],
          false,
        );
        assert.equal((await publish(client, revision("nostr")))[2], false);
        assert.equal(
          (await publish(client, revision("missing", base)))[2],
          false,
        );
        assert.equal(
          (await query(client, { kinds: [30818], "#d": ["nostr"] }))[0].id,
          secondArticle.id,
        );
        assert.equal(
          (await query(client, { ids: [firstArticle.id] })).length,
          0,
        );
        assert.equal(
          (
            await db.exec(
              "SELECT count(*) AS n FROM events WHERE kind = 30818 AND article_d = 'nostr'",
            )
          )[0].n,
          1,
        );
        const currentBase = tag(secondArticle, "head");
        const editorB = await connection(relay, t);
        const race = await Promise.all([
          publish(client, revision("nostr", currentBase, "race A")),
          publish(editorB, revision("nostr", currentBase, "race B")),
        ]);
        assert.equal(race.filter((message) => message[2]).length, 1);
        assert.match(
          race.find((message) => !message[2])[3],
          /^blocked:.*conflict/,
        );
        const afterRace = await wiki.getHistory("nostr");
        assert.equal(afterRace.length, 3);
        assert.equal(tag(afterRace[2].commit, "prev"), afterRace[1].commit.id);
      },
    );

    await t.test(
      "waits within the same second without publishing a future timestamp",
      async () => {
        // Align the first publication near the start of a real second.
        await delay(1000 - (Date.now() % 1000) + 20);
        const initial = revision("same-second");
        assert.equal((await publish(client, initial))[2], true);
        const article = await wiki.getArticle("same-second");
        assert.equal(Math.floor(Date.now() / 1000), article.created_at);
        const update = revision(
          "same-second",
          tag(article, "head"),
          "second snapshot",
        );
        const duplicateClient = await connection(relay, t);
        const results = await Promise.all([
          publish(client, update),
          publish(duplicateClient, update),
        ]);
        assert.ok(results.every((result) => result[2] === true));
        assert.equal(
          results.filter((result) => result[3].startsWith("duplicate:")).length,
          1,
        );
        const next = await wiki.getArticle("same-second");
        assert.ok(next.created_at > article.created_at);
        assert.ok(next.created_at <= Math.floor(Date.now() / 1000));
        assert.equal((await wiki.getHistory("same-second")).length, 2);
      },
    );

    await t.test(
      "rolls back all tables on a publication failure, and permits retry",
      async () => {
        const before = {};
        for (const table of [
          "events",
          "articles",
          "article_fts",
          "event_receipts",
        ]) {
          before[table] = await db.exec(`SELECT count(*) AS n FROM ${table}`);
        }
        await db.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON events WHEN NEW.kind = 30818
      BEGIN SELECT RAISE(ABORT, 'publication failure'); END`);
        const event = revision("atomic", undefined, "atomic content");
        assert.equal((await publish(client, event))[2], false);
        for (const table of Object.keys(before)) {
          assert.deepEqual(
            await db.exec(`SELECT count(*) AS n FROM ${table}`),
            before[table],
          );
        }
        const previous = await wiki.getArticle("nostr");
        const failedUpdate = revision(
          "nostr",
          tag(previous, "head"),
          "must roll back",
        );
        assert.equal((await publish(client, failedUpdate))[2], false);
        assert.deepEqual(await wiki.getArticle("nostr"), previous);
        for (const table of Object.keys(before)) {
          assert.deepEqual(
            await db.exec(`SELECT count(*) AS n FROM ${table}`),
            before[table],
          );
        }
        assert.equal(await wiki.getArticle("atomic"), null);
        assert.deepEqual(await wiki.getHistory("atomic"), []);
        await db.exec("DROP TRIGGER fail_publication");
        assert.equal((await publish(client, event))[2], true);
      },
    );

    await t.test(
      "implements OR filters, AND fields, tag filters, empty lists, bounds, and limits",
      async () => {
        const tagged = revision("filter-tags", undefined, "tagged", [
          ["p", getPublicKey(editorKey), wikiPubkey],
          ["x", "first", "second"],
        ]);
        assert.equal((await publish(client, tagged))[2], true);
        assert.equal(
          (
            await query(client, {
              "#p": [getPublicKey(editorKey)],
              "#x": ["first"],
            })
          )[0].id,
          tagged.id,
        );
        assert.deepEqual(await query(client, { "#p": [wikiPubkey] }), []);
        assert.deepEqual(await query(client, { "#x": ["second"] }), []);
        const all = await query(client, {});
        const sorted = [...all].sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
        assert.deepEqual(
          all.map((event) => event.id),
          sorted.map((event) => event.id),
        );
        for (const filter of [
          { ids: [] },
          { authors: [] },
          { kinds: [] },
          { "#a": [] },
          { limit: 0 },
        ]) {
          assert.deepEqual(await query(client, filter), []);
        }
        assert.deepEqual(
          (
            await query(client, {
              ids: [first.id],
              authors: [first.pubkey],
              kinds: [2818],
              since: first.created_at,
              until: first.created_at,
              "#a": [`30818:${wikiPubkey}:nostr`],
            })
          ).map((event) => event.id),
          [first.id],
        );
        assert.deepEqual(
          await query(client, { ids: [first.id], authors: [wikiPubkey] }),
          [],
        );
        assert.equal(
          (await query(client, { kinds: [2818], limit: 1 })).length,
          1,
        );
        const union = await query(
          client,
          { ids: [first.id] },
          { ids: [first.id, second.id] },
        );
        assert.deepEqual(
          union.map((event) => event.id),
          [...union]
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            )
            .map((event) => event.id),
        );
        assert.deepEqual(
          new Set(union.map((event) => event.id)),
          new Set([first.id, second.id]),
        );
        assert.equal(
          (await query(client, { kinds: [3818], "#e": [second.id] }))[0].id,
          tag(secondArticle, "head"),
        );
      },
    );

    await t.test(
      "queries large ID, author and kind lists safely, including beyond the SQL length limit",
      async () => {
        const ids = Array.from({ length: 2000 }, (_, i) =>
          i.toString(16).padStart(64, "0"),
        );
        for (const count of [200, 1000, 2000]) {
          const results = await query(client, {
            ids: [...ids.slice(0, count), first.id],
            authors: [...ids.slice(0, count), first.pubkey],
            kinds: [...Array.from({ length: 200 }, (_, i) => i), 2818],
            since: first.created_at,
            until: first.created_at,
          });
          assert.deepEqual(
            results.map((event) => event.id),
            [first.id],
          );
        }
        // Exercise the query boundary directly, without the WebSocket parser.
        for (const filter of [
          { ids: ["0".repeat(64) + "' OR 1=1 --"] },
          { authors: ["0".repeat(64) + "\n"] },
          { authors: ["A".repeat(64)] },
          { kinds: ["2818) OR 1=1 --"] },
          { kinds: [-1] },
        ]) {
          const response = await web.fetch("/__query", {
            method: "POST",
            body: JSON.stringify([filter]),
          });
          assert.equal(response.status, 400);
          assert.match((await response.json()).error, /^invalid:/);
        }
        assert.equal(
          (await query(client, { ids: [first.id] }))[0].id,
          first.id,
        );
      },
    );

    await t.test(
      "persists large subscriptions across hibernation and deletes their KV state on disconnect",
      async () => {
        const watcher = await connection(relay, t);
        const event = revision("large-subscriptions");
        const filler = Array.from({ length: 400 }, (_, i) =>
          i.toString(16).padStart(64, "0"),
        );
        const authors = {
          kinds: [3818],
          authors: [...filler, wikiPubkey],
          limit: 0,
        };
        const references = {
          kinds: [3818],
          "#e": [...filler, event.id],
          limit: 0,
        };
        assert.ok(JSON.stringify(authors).length > 16 * 1024);
        assert.ok(JSON.stringify(references).length > 16 * 1024);
        watcher.send(["REQ", "large-authors", authors, authors]);
        await watcher.next((message) => message[0] === "EOSE");
        watcher.send(["REQ", "large-references", references]);
        await watcher.next((message) => message[0] === "EOSE");
        const state = await wiki.subscriptionState();
        const key = state.find(([, subs]) =>
          subs.some((sub) => sub.id === "large-authors"),
        )[0];
        await relay.evictDurableObject("Wiki", {
          name: "wiki",
          webSockets: "hibernate",
        });
        assert.equal((await publish(client, event))[2], true);
        for (const id of ["large-authors", "large-references"]) {
          const message = await watcher.next(
            (message) => message[0] === "EVENT" && message[1] === id,
          );
          assert.equal(tag(message[2], "e"), event.id);
        }
        await query(watcher, { limit: 0 });
        assert.equal(
          watcher.inbox.filter((message) => message[0] === "EVENT").length,
          0,
        );
        watcher.socket.close(1000);
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            !(await wiki.subscriptionState()).some(([entry]) => entry === key)
          ) {
            break;
          }
          await delay(10);
        }
        assert.equal(
          (await wiki.subscriptionState()).some(([entry]) => entry === key),
          false,
        );
      },
    );

    await t.test(
      "rejects an oversized KV subscription without retaining the replaced filter or losing other subscriptions",
      async () => {
        const watcher = await connection(relay, t);
        watcher.send(["REQ", "kept", { kinds: [2818], limit: 0 }]);
        await watcher.next((message) => message[0] === "EOSE");
        watcher.send(["REQ", "replaced", { kinds: [2818], limit: 0 }]);
        await watcher.next((message) => message[0] === "EOSE");
        watcher.send([
          "REQ",
          "replaced",
          { "#x": ["x".repeat(9 * 1024 * 1024)], limit: 0 },
        ]);
        const rejected = await watcher.next(
          (message) => message[0] === "CLOSED",
        );
        assert.equal(rejected[1], "replaced");
        assert.match(rejected[2], /^error: unable to store subscription state/);
        const subscriptions = (await wiki.subscriptionState()).find(
          ([, subs]) => subs.some((sub) => sub.id === "kept"),
        )[1];
        assert.deepEqual(
          subscriptions.map((sub) => sub.id),
          ["kept"],
        );
        const event = revision("after-kv-rejection");
        assert.equal((await publish(client, event))[2], true);
        assert.equal(
          (
            await watcher.next(
              (message) => message[0] === "EVENT" && message[1] === "kept",
            )
          )[2].id,
          event.id,
        );
        await query(watcher, { limit: 0 });
        assert.equal(
          watcher.inbox.some((message) => message[1] === "replaced"),
          false,
        );
        watcher.send(["CLOSE", "kept"]);
        await query(watcher, { limit: 0 });
        assert.equal(
          (await wiki.subscriptionState()).some(([, subs]) =>
            subs.some((sub) => sub.id === "kept"),
          ),
          false,
        );
      },
    );

    await t.test(
      "keeps subscriptions independent, replaces and closes them, and restores them after hibernation",
      async () => {
        const watcher = await connection(relay, t);
        const other = await connection(relay, t);
        watcher.send([
          "REQ",
          "live",
          { kinds: [30818], "#d": ["live"], limit: 0 },
        ]);
        await watcher.next((message) => message[0] === "EOSE");
        other.send([
          "REQ",
          "live",
          { kinds: [2818], "#a": [`30818:${wikiPubkey}:live`], limit: 0 },
        ]);
        await other.next((message) => message[0] === "EOSE");
        await relay.evictDurableObject("Wiki", {
          name: "wiki",
          webSockets: "hibernate",
        });
        const event = revision("live");
        assert.equal((await publish(client, event))[2], true);
        const notification = await watcher.next(
          (message) => message[0] === "EVENT" && message[1] === "live",
        );
        assert.equal(notification[2].kind, 30818);
        verify(notification[2]);
        assert.equal(
          (
            await other.next(
              (message) => message[0] === "EVENT" && message[1] === "live",
            )
          )[2].id,
          event.id,
        );
        watcher.send([
          "REQ",
          "live",
          {
            kinds: [3818],
            "#a": [`30818:${wikiPubkey}:replacement`],
            limit: 0,
          },
        ]);
        await watcher.next(
          (message) => message[0] === "EOSE" && message[1] === "live",
        );
        const replacement = revision("replacement");
        assert.equal((await publish(client, replacement))[2], true);
        assert.equal(
          (
            await watcher.next(
              (message) => message[0] === "EVENT" && message[1] === "live",
            )
          )[2].kind,
          3818,
        );
        watcher.send(["CLOSE", "live"]);
        assert.equal(
          (
            await publish(
              client,
              revision(
                "replacement",
                tag(await wiki.getArticle("replacement"), "head"),
                "after close",
              ),
            )
          )[2],
          true,
        );
        await query(watcher, { limit: 0 });
        assert.equal(
          watcher.inbox.some(
            (message) => message[0] === "EVENT" && message[1] === "live",
          ),
          false,
        );
        // Multiple matching filters on one subscription still deliver an event once.
        watcher.send([
          "REQ",
          "once",
          { kinds: [2818], limit: 0 },
          { authors: [getPublicKey(editorKey)], limit: 0 },
        ]);
        await watcher.next((message) => message[0] === "EOSE");
        const unique = revision("once");
        await publish(client, unique);
        await query(watcher, { limit: 0 });
        assert.equal(
          watcher.inbox.filter(
            (message) =>
              message[0] === "EVENT" &&
              message[1] === "once" &&
              message[2].id === unique.id,
          ).length,
          1,
        );
      },
    );

    await t.test(
      "deletes subscriptions on WebSocket errors and sends an abnormal close",
      async () => {
        const watcher = await connection(relay, t);
        watcher.send(["REQ", "socket-error", { limit: 0 }]);
        await watcher.next((message) => message[0] === "EOSE");
        const closed = new Promise((resolve) =>
          watcher.socket.addEventListener("close", resolve, { once: true }),
        );
        await web.fetch("/__socket-error", { method: "POST" });
        assert.equal((await closed).code, 1011);
        assert.equal(
          (await wiki.subscriptionState()).some(([, subs]) =>
            subs.some((sub) => sub.id === "socket-error"),
          ),
          false,
        );
      },
    );

    await t.test(
      "searches with FTS5 trigram, field priorities, literal text, and Japanese",
      async () => {
        const fixtures = [
          ["ranking", "irrelevant", "", ""],
          ["rank-title-exact", "irrelevant", "ranking", ""],
          ["rank-title-partial", "irrelevant", "ranking guide", ""],
          ["rank-summary-exact", "irrelevant", "", "ranking"],
          ["rank-summary-partial", "irrelevant", "", "ranking guide"],
          ["rank-content-exact", "ranking", "", ""],
          ["rank-content-partial", "a ranking guide", "", ""],
          ["日本語記事", "日本語の本文です", "日本語の題名", "日本語の要約"],
          ["literal", 'a quote: "literal" example', "", ""],
        ];
        for (const [d, content, title, summary] of fixtures) {
          assert.equal(
            (
              await publish(
                client,
                revision(d, undefined, content, [
                  ["title", title],
                  ["summary", summary],
                ]),
              )
            )[2],
            true,
          );
        }
        const results = await query(client, {
          search: "ranking",
          authors: [wikiPubkey],
          kinds: [30818],
          limit: 20,
        });
        const ds = results.map((event) => tag(event, "d"));
        assert.deepEqual(
          new Set(ds.slice(0, 2)),
          new Set(["ranking", "rank-title-exact"]),
        );
        assert.deepEqual(ds.slice(2), [
          "rank-title-partial",
          "rank-summary-exact",
          "rank-summary-partial",
          "rank-content-exact",
          "rank-content-partial",
        ]);
        assert.deepEqual(
          (await query(client, { search: "ranking", limit: 2 })).map(
            (event) => event.id,
          ),
          results.slice(0, 2).map((event) => event.id),
        );
        assert.deepEqual(
          await query(client, { search: "ranking", kinds: [2818] }),
          [],
        );
        assert.equal((await query(client, { search: "日本語" })).length, 1);
        assert.equal((await query(client, { search: '"literal"' })).length, 1);
        assert.deepEqual(await query(client, { search: "日" }), []);
        assert.equal(
          (await query(client, { search: "ranking unknown:extension" })).length,
          results.length,
        );
        const original = await wiki.getArticle("rank-content-exact");
        assert.equal(
          (
            await publish(
              client,
              revision("rank-content-exact", tag(original, "head"), "new text"),
            )
          )[2],
          true,
        );
        assert.ok(
          !(await query(client, { search: "ranking" })).some(
            (event) => event.id === original.id,
          ),
        );
        const searchWatcher = await connection(relay, t);
        searchWatcher.send([
          "REQ",
          "search",
          { search: "live-search", limit: 0 },
        ]);
        await searchWatcher.next((message) => message[0] === "EOSE");
        const searched = revision(
          "search-notification",
          undefined,
          "live-search notification",
        );
        await publish(client, searched);
        assert.equal(
          (
            await searchWatcher.next(
              (message) => message[0] === "EVENT" && message[1] === "search",
            )
          )[2].kind,
          30818,
        );
      },
    );

    await t.test(
      "excludes unpublished history, articles, search results and new edits",
      async () => {
        const hidden = await wiki.getArticle("ranking");
        await db.exec(
          "UPDATE articles SET is_published = 0 WHERE d = ?",
          "ranking",
        );
        await db.exec(
          "DELETE FROM article_fts WHERE rowid = (SELECT id FROM articles WHERE d = ?)",
          "ranking",
        );
        assert.equal(await wiki.getArticle("ranking"), null);
        assert.deepEqual(await wiki.getHistory("ranking"), []);
        assert.deepEqual(
          await query(client, { "#a": [`30818:${wikiPubkey}:ranking`] }),
          [],
        );
        assert.deepEqual(await query(client, { "#d": ["ranking"] }), []);
        assert.ok(
          !(await query(client, { search: "ranking" })).some(
            (event) => event.id === hidden.id,
          ),
        );
        const before = await db.exec(
          "SELECT count(*) AS n FROM events WHERE article_d = ?",
          "ranking",
        );
        assert.match(
          (
            await publish(
              client,
              revision("ranking", tag(hidden, "head"), "hidden edit"),
            )
          )[3],
          /^blocked:/,
        );
        assert.match(
          (await publish(client, revision("ranking")))[3],
          /^blocked:/,
        );
        assert.deepEqual(
          await db.exec(
            "SELECT count(*) AS n FROM events WHERE article_d = ?",
            "ranking",
          ),
          before,
        );
      },
    );

    await t.test(
      "preserves accepted history, receipts, and search after a Durable Object restart",
      async () => {
        const before = await wiki.getHistory("nostr");
        const receipt = await db.exec(
          "SELECT * FROM event_receipts WHERE revision_id = ?",
          Buffer.from(first.id, "hex"),
        );
        await relay.evictDurableObject("Wiki", {
          name: "wiki",
          webSockets: "close",
        });
        assert.deepEqual(await wiki.getHistory("nostr"), before);
        const orphaned = await wiki.subscriptionState();
        assert.ok(
          orphaned.length > 0,
          "constructor must leave subscription KV for the Alarm",
        );
        const scheduled = (await wiki.alarmState()).scheduled;
        assert.ok(scheduled > Date.now());
        assert.deepEqual(
          await db.exec(
            "SELECT * FROM event_receipts WHERE revision_id = ?",
            Buffer.from(first.id, "hex"),
          ),
          receipt,
        );
        const after = await connection(relay, t);
        assert.ok((await query(after, { search: "日本語" })).length > 0);
        assert.match((await publish(after, first))[3], /^duplicate:/);
        assert.equal(await wiki.getArticle("ranking"), null);
        const watcher = await connection(relay, t);
        watcher.send(["REQ", "after-restart", { kinds: [2818], limit: 0 }]);
        await watcher.next((message) => message[0] === "EOSE");
        assert.equal((await wiki.alarmState()).scheduled, scheduled);
        // Force a real Alarm dispatch now rather than waiting 24 hours.
        // A failed rebooking preserves orphan deletion; the runtime retries it.
        const beforeCleanup = Date.now();
        const next = await wiki.triggerCleanup(true);
        assert.notEqual(
          next.failedCleanupKeys,
          null,
          "Alarm rebooking must have failed before the runtime retry",
        );
        assert.ok(
          next.failedCleanupKeys.length > 0,
          "active subscriptions must remain",
        );
        assert.ok(
          next.failedCleanupKeys.every(
            (key) => !orphaned.some(([old]) => old === key),
          ),
          "successful deletion must survive rebooking failure",
        );
        const day = 24 * 60 * 60 * 1000;
        assert.ok(
          next.scheduled >= beforeCleanup + day &&
            next.scheduled <= Date.now() + day,
        );
        assert.ok(
          (await wiki.subscriptionState()).every(
            ([key]) => !orphaned.some(([old]) => old === key),
          ),
        );
        const event = revision("after-alarm");
        assert.equal((await publish(after, event))[2], true);
        assert.equal(
          (
            await watcher.next(
              (message) =>
                message[0] === "EVENT" && message[1] === "after-restart",
            )
          )[2].id,
          event.id,
        );
        watcher.send(["CLOSE", "after-restart"]);
        // CLOSE is immediate; it need not scan KV or cancel the scheduled Alarm.
        watcher.send(["UNKNOWN"]);
        await watcher.next((message) => message[0] === "NOTICE");
        assert.deepEqual(await wiki.subscriptionState(), []);
        assert.equal((await wiki.alarmState()).scheduled, next.scheduled);
        assert.equal((await wiki.triggerCleanup()).scheduled, null);
      },
    );
  },
);
