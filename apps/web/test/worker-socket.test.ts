/**
 * Drives WorkerSocket under Node with fake browser globals: a scripted
 * WebSocket, a fake controller behind fetch, sessionStorage, and mocked timers.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { WorkerSocket, type Status } from "@/lib/worker-socket";

type Handler = ((event: never) => void) | null;

class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  protocol = "";
  readonly sent: Uint8Array[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.emitClose(code ?? 1000, true);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.protocol = "lambda-microvms";
    (this.onopen as (() => void) | null)?.();
  }

  emitClose(code: number, wasClean: boolean): void {
    this.readyState = FakeWebSocket.CLOSED;
    (
      this.onclose as ((event: { code: number; wasClean: boolean; reason: string }) => void) | null
    )?.({
      code,
      wasClean,
      reason: "",
    });
  }
}

type Controller = {
  posts: { path: string; method: string; body: unknown }[];
  respond: (path: string, method: string) => { status: number; body: unknown };
};

function installGlobals(controller: Controller): void {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: {
      visibilityState: "visible",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    location: { protocol: "http:", host: "localhost:5173" },
    fetch: async (path: string, init?: { method?: string; body?: string | null }) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      controller.posts.push({ path, method, body });
      const { status, body: responseBody } = controller.respond(path, method);
      return {
        // eslint id-length: `ok` is the Response field name, not our choice
        ok: status >= 200 && status < 300,
        status,
        json: async () => responseBody,
      };
    },
  });
}

function sessionResponse(sessionId: string, microvmId = "mvm-1") {
  return {
    sessionId,
    microvmId,
    createdAt: Date.now(),
    state: "RUNNING",
    stateReason: null,
    wsUrl: `ws://gateway/mvm/${microvmId}/ws`,
    token: `token-${Math.random().toString(36).slice(2)}`,
    expiresAt: Date.now() + 60_000,
    backend: "local",
  };
}

function happyController(): Controller {
  const controller: Controller = {
    posts: [],
    respond(path, method) {
      if (path === "/api/sessions" && method === "POST") {
        const last = controller.posts.at(-1);
        const requested = (last?.body as { sessionId?: string } | null)?.sessionId;
        return { status: 200, body: sessionResponse(requested ?? "generated") };
      }
      if (path.endsWith("/token")) {
        const sessionId = path.split("/")[3] ?? "";
        return { status: 200, body: sessionResponse(sessionId) };
      }
      return { status: 200, body: {} };
    },
  };
  return controller;
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}

describe("WorkerSocket", () => {
  let controller: Controller;
  let statuses: Status[];

  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    controller = happyController();
    installGlobals(controller);
    statuses = [];
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("chooses and stores the session id before the first request", async () => {
    const socket = new WorkerSocket();
    socket.onStatus((status) => statuses.push(status));
    await socket.connect();
    const first = controller.posts[0];
    assert.ok(first);
    assert.equal(first.path, "/api/sessions");
    const sent = (first.body as { sessionId: string }).sessionId;
    assert.match(sent, /^[0-9a-f-]{36}$/u);
    assert.equal(sessionStorage.getItem("microvm.sessionId"), sent);
    const websocket = FakeWebSocket.instances[0];
    assert.ok(websocket);
    assert.deepEqual(websocket.protocols.slice(0, 1), ["lambda-microvms"]);
    assert.match(websocket.protocols[1] ?? "", /^lambda-microvms\.authentication\./u);
    websocket.emitOpen();
    assert.deepEqual(statuses, ["starting", "connecting", "open"]);
  });

  it("two overlapping instances share one session id (StrictMode)", async () => {
    const first = new WorkerSocket();
    const second = new WorkerSocket();
    const pending = first.connect();
    first.close();
    await Promise.all([pending, second.connect()]);
    const ids = controller.posts.map((post) => (post.body as { sessionId: string }).sessionId);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(FakeWebSocket.instances.length, 1, "the closed instance opened no socket");
  });

  it("backs off exponentially, gives up after the cap, and retry starts over", async () => {
    const socket = new WorkerSocket();
    socket.onStatus((status) => statuses.push(status));
    await socket.connect();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = FakeWebSocket.instances.at(-1);
      assert.ok(current);
      current.emitClose(1006, false);
      const expected = Math.min(1000 * 2 ** attempt, 30_000);
      delays.push(expected);
      mock.timers.tick(expected - 1);
      await flush();
      assert.equal(FakeWebSocket.instances.length, attempt + 1, "not before the delay");
      mock.timers.tick(1);
      await flush();
      assert.equal(FakeWebSocket.instances.length, attempt + 2, "reconnects after the delay");
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    FakeWebSocket.instances.at(-1)?.emitClose(1006, false);
    await flush();
    assert.equal(socket.status, "failed");
    const before = FakeWebSocket.instances.length;
    socket.retry();
    mock.timers.tick(1000);
    await flush();
    assert.equal(FakeWebSocket.instances.length, before + 1);
  });

  it("reopens the session under the remembered id when the controller says 410", async () => {
    let gone = true;
    controller.respond = (path, method) => {
      if (path.endsWith("/token") && gone) {
        return { status: 410, body: { message: "SessionGone" } };
      }
      if (path === "/api/sessions" && method === "POST") {
        const last = controller.posts.at(-1);
        const requested = (last?.body as { sessionId?: string } | null)?.sessionId;
        return { status: 200, body: sessionResponse(requested ?? "x", "mvm-2") };
      }
      return { status: 200, body: {} };
    };
    const socket = new WorkerSocket();
    await socket.connect();
    const sessionId = sessionStorage.getItem("microvm.sessionId");
    FakeWebSocket.instances[0]?.emitOpen();
    FakeWebSocket.instances[0]?.emitClose(1006, false);
    mock.timers.tick(1000);
    await flush();
    gone = false;
    mock.timers.tick(2000);
    await flush();
    const reopen = controller.posts.filter((post) => post.path === "/api/sessions");
    assert.equal(reopen.length, 2, "a fresh POST /api/sessions after the 410");
    const second = reopen[1];
    assert.ok(second);
    assert.equal((second.body as { sessionId: string }).sessionId, sessionId);
    assert.equal(socket.session?.microvmId, "mvm-2");
  });

  it("does not reconnect after an explicit close", async () => {
    const socket = new WorkerSocket();
    await socket.connect();
    FakeWebSocket.instances[0]?.emitOpen();
    socket.close();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(socket.status, "closed");
  });
});
