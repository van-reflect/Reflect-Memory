// SSE /events integration tests.
//
// These tests use raw fetch against the spawned test server so we can verify
// the stream behavior end-to-end (headers, hello frame, event delivery,
// keepalives, teardown) without stubbing.
//
// Uses an AbortController per test to close the stream deterministically.

import { afterEach, describe, expect, it } from "vitest";
import { api, getTestServer } from "../helpers";

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

/**
 * Open the SSE stream and return a controller + async iterator over parsed
 * events. Caller must call `close()` when done, and should race the iterator
 * against a timeout since SSE never ends naturally.
 */
function openStream(token: string): {
  close: () => void;
  events: () => AsyncGenerator<ParsedSseEvent, void, void>;
} {
  const { baseUrl } = getTestServer();
  const controller = new AbortController();

  const streamPromise = fetch(`${baseUrl}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });

  async function* events() {
    const res = await streamPromise;
    if (!res.ok || !res.body) {
      throw new Error(`events stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        while (true) {
          const idx = buf.indexOf("\n\n");
          if (idx === -1) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          let eventName = "message";
          let dataStr = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue; // keepalive comment
            if (line.startsWith("event: ")) eventName = line.slice(7);
            else if (line.startsWith("data: ")) dataStr += line.slice(6);
          }
          if (dataStr.length > 0) {
            try {
              yield { event: eventName, data: JSON.parse(dataStr) };
            } catch {
              yield { event: eventName, data: dataStr };
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  return {
    close: () => controller.abort(),
    events,
  };
}

async function waitForEvent(
  iter: AsyncGenerator<ParsedSseEvent>,
  predicate: (e: ParsedSseEvent) => boolean,
  timeoutMs = 3000,
): Promise<ParsedSseEvent> {
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms waiting for event`)), timeoutMs),
  );
  // Use iter.next() directly instead of `for await` — `for await` triggers
  // iterator cleanup on early return/break, which closes the underlying
  // reader and makes subsequent waitForEvent calls fail.
  const next = (async () => {
    while (true) {
      const step = await iter.next();
      if (step.done) throw new Error("stream ended before predicate matched");
      if (predicate(step.value)) return step.value;
    }
  })();
  return Promise.race([next, timeout]);
}

describe("GET /events", () => {
  const openStreams: Array<() => void> = [];

  afterEach(() => {
    while (openStreams.length > 0) {
      const close = openStreams.pop()!;
      try {
        close();
      } catch {
        // ignore
      }
    }
  });

  it("rejects agent keys with 403", async () => {
    const { agentKeys } = getTestServer();
    const res = await fetch(`${getTestServer().baseUrl}/events`, {
      headers: { Authorization: `Bearer ${agentKeys.cursor}` },
    });
    expect(res.status).toBe(403);
  });

  it("sends a hello frame with subscribed scope on connect", async () => {
    const { apiKey } = getTestServer();
    const stream = openStream(apiKey);
    openStreams.push(stream.close);

    const hello = await waitForEvent(stream.events(), (e) => e.event === "hello");
    expect(hello.event).toBe("hello");
    expect((hello.data as { subscribed: { user_id: string } }).subscribed.user_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("delivers a memory.created event after POST /memories", async () => {
    const { apiKey } = getTestServer();
    const stream = openStream(apiKey);
    openStreams.push(stream.close);
    const iter = stream.events();

    // Drain the hello frame first so subsequent events are fresh.
    await waitForEvent(iter, (e) => e.event === "hello");

    // Trigger a write in parallel with waiting for the event.
    const writePromise = api<{ id: string; title: string }>("POST", "/memories", {
      body: {
        title: "sse-test-created",
        content: "sse-test-body",
        tags: ["sse-events"],
      },
    });

    const evt = await waitForEvent(iter, (e) => e.event === "memory.created");
    const write = await writePromise;
    expect(write.status).toBe(201);

    const payload = evt.data as {
      memory_id: string;
      user_id: string;
      memory: { title: string; tags: string[] };
    };
    expect(payload.memory_id).toBe(write.json.id);
    expect(payload.memory.title).toBe("sse-test-created");
    expect(payload.memory.tags).toContain("sse-events");

    await api("DELETE", `/memories/${write.json.id}/permanent`, {});
  });

  it("delivers a memory.deleted then memory.purged pair for trash then permanent", async () => {
    const { apiKey } = getTestServer();

    // Create outside the stream so we control when the stream opens.
    const created = await api<{ id: string }>("POST", "/memories", {
      body: {
        title: "sse-test-trash-cycle",
        content: "body",
        tags: ["sse-events"],
      },
    });
    expect(created.status).toBe(201);
    const id = created.json.id;

    const stream = openStream(apiKey);
    openStreams.push(stream.close);
    const iter = stream.events();
    await waitForEvent(iter, (e) => e.event === "hello");

    await api("DELETE", `/memories/${id}`, {});
    const del = await waitForEvent(iter, (e) => e.event === "memory.deleted");
    expect((del.data as { memory_id: string }).memory_id).toBe(id);

    await api("DELETE", `/memories/${id}/permanent`, {});
    const purge = await waitForEvent(iter, (e) => e.event === "memory.purged");
    expect((purge.data as { memory_id: string }).memory_id).toBe(id);
    // includeBody:false on purge
    expect((purge.data as { memory?: unknown }).memory).toBeUndefined();
  });
});
