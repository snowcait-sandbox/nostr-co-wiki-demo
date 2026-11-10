import { administer } from "./admin";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { DurableObject } from "cloudflare:workers";
import type { Event } from "nostr-tools/pure";

type WikiEvent = Omit<Event, symbol>;
import type { Filter } from "nostr-tools/filter";
import { acceptRevision } from "./revision";
import { getArticle, getArticleStatus, getHistory, queryEvents } from "./query";
import { schema } from "./schema";
import { matches, parseFilter, record, signedEvent } from "./protocol";

interface Connection {
  ip: string;
  id: string;
}

type Subscription = { id: string; filters: Filter[] };

const subscriptionCleanupInterval = 24 * 60 * 60 * 1000;

interface WikiEnvironment {
  WIKI_PRIVATE_KEY: string;
  ADMIN_PUBLIC_KEY?: string;
}

export class Wiki extends DurableObject<WikiEnvironment> {
  constructor(ctx: DurableObjectState, env: WikiEnvironment) {
    super(ctx, env);
    ctx.storage.sql.exec(schema);
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/admin/")) {
      return administer(request, this.ctx.storage, this.env.ADMIN_PUBLIC_KEY);
    }
    if (
      new URL(request.url).pathname !== "/" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Not Found", { status: 404 });
    }
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) {
      return new Response("Missing connection address", { status: 400 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      ip,
      id: crypto.randomUUID(),
    } satisfies Connection);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    socket: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    let message: unknown;
    try {
      if (typeof data !== "string") {
        throw new Error();
      }
      message = JSON.parse(data);
    } catch {
      this.#send(socket, ["NOTICE", "invalid: expected a JSON message"]);
      return;
    }
    if (!Array.isArray(message)) {
      this.#send(socket, ["NOTICE", "invalid: expected a message array"]);
      return;
    }
    if (message[0] === "EVENT") {
      const id =
        record(message[1]) && typeof message[1].id === "string"
          ? message[1].id
          : "";
      let event: Event;
      let accepted: Event[];
      try {
        if (message.length !== 2) {
          throw new Error("invalid: EVENT message");
        }
        event = signedEvent(message[1]);
        const connection: Connection = socket.deserializeAttachment();
        accepted = await acceptRevision(
          this.ctx.storage,
          this.env.WIKI_PRIVATE_KEY,
          event,
          connection.ip,
        );
      } catch (error) {
        const reason =
          error instanceof Error && /^(invalid|blocked):/.test(error.message)
            ? error.message
            : "error: unable to accept Revision";
        this.#send(socket, ["OK", id, false, reason]);
        return;
      }
      this.#send(socket, [
        "OK",
        event.id,
        true,
        accepted.length ? "" : "duplicate: already accepted",
      ]);
      for (const published of accepted) {
        this.#broadcast(published);
      }
      return;
    }
    if (message[0] === "REQ" || message[0] === "CLOSE") {
      const id = message[1];
      if (typeof id !== "string" || !id || [...id].length > 64) {
        this.#send(socket, ["NOTICE", "invalid: subscription ID"]);
        return;
      }
      const connection: Connection = socket.deserializeAttachment();
      const key = `subscriptions:${connection.id}`;
      try {
        const subscriptions = (
          this.ctx.storage.kv.get<Subscription[]>(key) ?? []
        ).filter((sub) => sub.id !== id);
        // Remove a replaced subscription before validation. A failed REQ closes it.
        if (subscriptions.length) {
          this.ctx.storage.kv.put(key, subscriptions);
        } else {
          this.ctx.storage.kv.delete(key);
        }
        if (message[0] === "CLOSE") {
          return;
        }
        if (message.length < 3) {
          throw new Error("invalid: REQ needs filters");
        }
        const filters = message.slice(2).map(parseFilter);
        const events = queryEvents(this.ctx.storage.sql, filters);
        try {
          this.ctx.storage.kv.put(key, [...subscriptions, { id, filters }]);
        } catch {
          throw new Error("error: unable to store subscription state");
        }
        try {
          if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(
              Date.now() + subscriptionCleanupInterval,
            );
          }
        } catch (error) {
          console.error("Unable to schedule subscription cleanup Alarm", error);
        }
        for (const event of events) {
          this.#send(socket, ["EVENT", id, event]);
        }
        this.#send(socket, ["EOSE", id]);
      } catch (error) {
        this.#send(socket, [
          "CLOSED",
          id,
          error instanceof Error &&
          /^(invalid|unsupported|error):/.test(error.message)
            ? error.message
            : "error: unable to retrieve events",
        ]);
      }
      return;
    }
    this.#send(socket, ["NOTICE", "unsupported: message type"]);
  }

  async alarm(): Promise<void> {
    const connections = new Set(
      this.ctx.getWebSockets().map((socket) => {
        const connection: Connection = socket.deserializeAttachment();
        return `subscriptions:${connection.id}`;
      }),
    );
    let remaining = false;
    for (const [key] of this.ctx.storage.kv.list({
      prefix: "subscriptions:",
    })) {
      if (connections.has(key)) {
        remaining = true;
      } else {
        this.ctx.storage.kv.delete(key);
      }
    }
    if (remaining) {
      await this.ctx.storage.setAlarm(Date.now() + subscriptionCleanupInterval);
    }
  }

  webSocketClose(socket: WebSocket): void {
    this.#deleteSubscriptions(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.#deleteSubscriptions(socket);
    socket.close(1011, "Connection error");
  }

  #deleteSubscriptions(socket: WebSocket): void {
    const connection: Connection = socket.deserializeAttachment();
    this.ctx.storage.kv.delete(`subscriptions:${connection.id}`);
  }

  getWikiPublicKey(): string {
    const key = decode(this.env.WIKI_PRIVATE_KEY);
    if (key.type !== "nsec") {
      throw new Error("Wiki signing key must be nsec");
    }
    return getPublicKey(key.data);
  }

  getArticleStatus(d: string): "available" | "published" | "unpublished" {
    return getArticleStatus(this.ctx.storage.sql, d);
  }

  searchArticles(search: string): WikiEvent[] {
    return queryEvents(this.ctx.storage.sql, [
      { kinds: [30818], authors: [this.getWikiPublicKey()], search, limit: 50 },
    ]);
  }

  getRecentArticles(): WikiEvent[] {
    return queryEvents(this.ctx.storage.sql, [{ kinds: [30818] }]);
  }

  getArticle(d: string): WikiEvent | null {
    return getArticle(this.ctx.storage.sql, d);
  }

  getHistory(d: string): { commit: WikiEvent; revision: WikiEvent | null }[] {
    return getHistory(this.ctx.storage.sql, d);
  }

  #send(socket: WebSocket, message: unknown[]): void {
    // A disconnected peer must not turn an already committed edit into a rejection.
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  #broadcast(event: Event): void {
    for (const socket of this.ctx.getWebSockets()) {
      const connection: Connection = socket.deserializeAttachment();
      const subscriptions =
        this.ctx.storage.kv.get<Subscription[]>(
          `subscriptions:${connection.id}`,
        ) ?? [];
      for (const sub of subscriptions) {
        if (sub.filters.some((filter) => matches(event, filter))) {
          this.#send(socket, ["EVENT", sub.id, event]);
        }
      }
    }
  }
}
