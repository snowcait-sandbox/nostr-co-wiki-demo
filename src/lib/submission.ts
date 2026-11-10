import type { Event, EventTemplate } from "nostr-tools/pure";
import { validateEvent, verifyEvent } from "nostr-tools/pure";
import type { WindowNostr } from "nostr-tools/nip07";
import { isHex32 } from "nostr-tools/utils";

export function createRevision(input: {
  wikiPubkey: string;
  d: string;
  title: string;
  summary: string;
  editSummary: string;
  content: string;
  base?: string;
}): EventTemplate {
  return {
    kind: 2818,
    created_at: Math.floor(Date.now() / 1000),
    content: input.content,
    tags: [
      ["a", `30818:${input.wikiPubkey}:${input.d}`],
      ...(input.base ? [["e", input.base]] : []),
      ["title", input.title],
      ...(input.summary ? [["summary", input.summary]] : []),
      ...(input.editSummary ? [["edit_summary", input.editSummary]] : []),
    ],
  };
}
export type SubmissionResult = {
  type: "accepted" | "signing" | "connection" | "conflict" | "rejected";
  message: string;
  id?: string;
};

export async function submitRevision(
  signer: WindowNostr | undefined,
  relay: string,
  template: EventTemplate,
): Promise<SubmissionResult> {
  if (!signer) {
    return {
      type: "signing",
      message:
        "A NIP-07 compatible signing extension is required to create or edit articles.",
    };
  }
  let event: Event;
  try {
    const signed = await signer.signEvent(structuredClone(template));
    if (
      !validateEvent(signed) ||
      typeof signed.id !== "string" ||
      !isHex32(signed.id) ||
      typeof signed.sig !== "string"
    ) {
      throw new Error();
    }
    event = {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      content: signed.content,
      tags: signed.tags,
      sig: signed.sig,
    };
    if (
      event.kind !== template.kind ||
      event.created_at !== template.created_at ||
      event.content !== template.content ||
      JSON.stringify(event.tags) !== JSON.stringify(template.tags) ||
      !verifyEvent(event)
    ) {
      throw new Error();
    }
  } catch {
    return {
      type: "signing",
      message:
        "Signing was declined or the signer returned an invalid Revision. Your draft is preserved.",
    };
  }
  return new Promise((resolve) => {
    let socket: WebSocket;
    let settled = false;
    const finish = (result: SubmissionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        socket.close();
      }
      resolve(result);
    };
    const failed: SubmissionResult = {
      type: "connection",
      message:
        "No acceptance confirmation was received. Your draft is preserved; check the article before resubmitting.",
    };
    const timeout = setTimeout(() => finish(failed), 15000);
    try {
      socket = new WebSocket(relay);
    } catch {
      finish(failed);
      return;
    }
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify(["EVENT", event])),
    );
    socket.addEventListener("error", () => finish(failed));
    socket.addEventListener("close", () => finish(failed));
    socket.addEventListener("message", ({ data }) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (
        !Array.isArray(message) ||
        message[0] !== "OK" ||
        message[1] !== event.id ||
        typeof message[2] !== "boolean"
      ) {
        return;
      }
      const reason =
        typeof message[3] === "string" ? message[3] : "Revision rejected.";
      finish(
        message[2]
          ? {
              type: "accepted",
              message: "Revision accepted. Checking publication…",
              id: event.id,
            }
          : {
              type: /conflict/i.test(reason) ? "conflict" : "rejected",
              message: reason,
            },
      );
    });
  });
}
