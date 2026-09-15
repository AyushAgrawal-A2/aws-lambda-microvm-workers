/**
 * End-to-end: browser-shaped client -> controller -> local gateway -> worker
 * container. Needs Docker and the microvm-worker:dev image (pnpm worker:image).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { EnvelopeSchema } from "@workers/proto";
import { parseSessionInfo, parseSessionState } from "@workers/session-api";

const IMAGE = "microvm-worker:dev";
const IDLE_SECONDS = 3;
const ROOT = path.resolve(import.meta.dirname, "../../..");

function imageAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("no port"));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  /* oxlint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error(`${url} never became healthy`);
}

function start(app: string, env: Record<string, string>): ChildProcess {
  const cwd = path.join(ROOT, "apps", app);
  const child = spawn(path.join(cwd, "node_modules/.bin/tsx"), ["src/main.ts"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${app}] ${chunk.toString()}`);
  });
  return child;
}

/** GET /health with an explicit Host header, which fetch would silently drop. */
function statusWithHost(baseUrl: string, host: string): Promise<number> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname, port, path: "/health", method: "GET", headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

function field(value: unknown, name: string): string {
  const found = isRecord(value) ? value[name] : undefined;
  if (typeof found !== "string") {
    throw new TypeError(`missing "${name}"`);
  }
  return found;
}

const protocols = (token: string) => [
  "lambda-microvms",
  `lambda-microvms.authentication.${token}`,
  "lambda-microvms.port.8080",
];

/** Opens a socket the way the browser does, sends one exec, resolves on the reply. */
function execOnce(
  wsUrl: string,
  token: string,
  command: string,
): Promise<{ socket: WebSocket; reply: string; selected: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, protocols(token));
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      reject(new Error("websocket timeout"));
    }, 15_000);
    socket.onopen = () => {
      const envelope = create(EnvelopeSchema, {
        messageId: 1n,
        payload: { case: "exec", value: { command, stdin: new Uint8Array() } },
      });
      socket.send(toBinary(EnvelopeSchema, envelope));
    };
    socket.onmessage = (event) => {
      clearTimeout(timer);
      if (!(event.data instanceof ArrayBuffer)) {
        return;
      }
      const envelope = fromBinary(EnvelopeSchema, new Uint8Array(event.data));
      const reply =
        envelope.payload.case === "result"
          ? new TextDecoder().decode(envelope.payload.value.stdout)
          : "";
      resolve({ socket, reply, selected: socket.protocol });
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    };
  });
}

describe("session lifecycle through the local gateway", { skip: !imageAvailable() }, () => {
  const processes: ChildProcess[] = [];
  let controllerUrl = "";
  let gatewayUrl = "";

  before(async () => {
    const gatewayPort = await freePort();
    const controllerPort = await freePort();
    gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    controllerUrl = `http://127.0.0.1:${controllerPort}`;
    processes.push(start("local-gateway", { GATEWAY_PORT: String(gatewayPort) }));
    await waitForHealth(`${gatewayUrl}/health`);
    processes.push(
      start("controller", {
        CONTROLLER_PORT: String(controllerPort),
        LOCAL_GATEWAY_URL: gatewayUrl,
        MICROVM_MAX_IDLE_SECONDS: String(IDLE_SECONDS),
        MICROVM_SUSPENDED_SECONDS: "120",
      }),
    );
    await waitForHealth(`${controllerUrl}/health`);
  });

  after(async () => {
    for (const child of processes) {
      child.kill("SIGTERM");
    }
    await sleep(1500);
    for (const child of processes) {
      child.kill("SIGKILL");
    }
  });

  const api = async (route: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await fetch(`${controllerUrl}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status}`);
    }
    return response.json();
  };

  it("runs a MicroVM, talks to it, suspends when idle, resumes on traffic, terminates", async () => {
    const session = parseSessionInfo(await api("/api/sessions", "POST"));
    const { sessionId, microvmId, wsUrl, token } = session;
    assert.equal(session.state, "RUNNING");

    const plainText = await fetch(`${controllerUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(plainText.status, 415, "non-JSON mutations are refused (CSRF guard)");
    const plainTextGateway = await fetch(`${gatewayUrl}/microvms`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(plainTextGateway.status, 415, "gateway refuses non-JSON mutations too");
    const badId = await fetch(`${controllerUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "not-a-uuid" }),
    });
    assert.equal(badId.status, 400, "session ids must be UUIDs");

    const reopened = await api("/api/sessions", "POST", { sessionId });
    assert.equal(field(reopened, "microvmId"), microvmId, "reopen is idempotent");

    const polled = await api(`/api/sessions/${sessionId}`);
    assert.equal(isRecord(polled) && "token" in polled, false, "GET must not mint tokens");
    assert.equal(parseSessionState(polled).microvmId, microvmId, "GET parses as SessionState");

    const httpBase = wsUrl.replace("ws://", "http://").replace(/\/ws$/u, "");
    assert.equal((await fetch(`${httpBase}/health`)).status, 403, "no token -> 403");
    const hookViaProxy = await fetch(`${httpBase}/aws/lambda-microvms/runtime/v1/suspend`, {
      method: "POST",
      headers: { "X-aws-proxy-auth": token },
    });
    assert.equal(hookViaProxy.status, 403, "hooks are not reachable through the endpoint");
    // fetch drops a custom Host header (it is forbidden by the spec); node:http sends it.
    assert.equal(
      await statusWithHost(controllerUrl, "evil.example"),
      421,
      "foreign Host headers are refused (DNS rebinding)",
    );
    assert.equal(
      await statusWithHost(gatewayUrl, "evil.example:4590"),
      421,
      "gateway refuses foreign Host headers too",
    );

    const first = await execOnce(wsUrl, token, "echo one");
    assert.equal(first.reply, "echo one");
    assert.equal(first.selected, "lambda-microvms", "base subprotocol is selected");
    first.socket.close(1000);

    let state = "";
    /* oxlint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 30 && state !== "SUSPENDED"; attempt += 1) {
      await sleep(500);
      state = field(await api(`/api/sessions/${sessionId}`), "state");
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(state, "SUSPENDED", "idle policy suspends");
    const paused = execFileSync("docker", ["inspect", "-f", "{{.State.Paused}}", microvmId])
      .toString()
      .trim();
    assert.equal(paused, "true", "suspended VM is a paused container");

    const refreshed = parseSessionInfo(await api(`/api/sessions/${sessionId}/token`, "POST"));
    const freshToken = refreshed.token;
    assert.notEqual(freshToken, token);
    const second = await execOnce(wsUrl, freshToken, "echo two");
    assert.equal(second.reply, "echo two", "traffic auto-resumes");
    assert.equal(field(await api(`/api/sessions/${sessionId}`), "state"), "RUNNING");
    second.socket.close(1000);

    const ended = await api(`/api/sessions/${sessionId}`, "DELETE");
    assert.equal(field(ended, "state"), "TERMINATED");
    assert.equal((await fetch(`${controllerUrl}/api/sessions/${sessionId}`)).status, 404);
    const leftovers = execFileSync("docker", ["ps", "-aq", "--filter", `name=${microvmId}`])
      .toString()
      .trim();
    assert.equal(leftovers, "", "container is removed");
  });

  it("reaps a MicroVM whose container dies", async () => {
    const session = await api("/api/sessions", "POST");
    const sessionId = field(session, "sessionId");
    const microvmId = field(session, "microvmId");
    execFileSync("docker", ["kill", microvmId], { stdio: "ignore" });

    let state = "";
    /* oxlint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 30 && state !== "TERMINATED"; attempt += 1) {
      await sleep(500);
      const response = await fetch(`${gatewayUrl}/microvms/${microvmId}`);
      const view: unknown = await response.json();
      state = field(view, "state");
    }
    /* oxlint-enable no-await-in-loop */
    assert.equal(state, "TERMINATED", "dead container is reaped");
    const gone = await fetch(`${controllerUrl}/api/sessions/${sessionId}`);
    assert.equal(gone.status, 410, "controller answers 410 for a dead MicroVM");
    const tokenGone = await fetch(`${controllerUrl}/api/sessions/${sessionId}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(tokenGone.status, 404, "the dropped session is unknown afterwards");
    const reopened = await api("/api/sessions", "POST", { sessionId });
    assert.notEqual(field(reopened, "microvmId"), microvmId, "reopen runs a fresh MicroVM");
    assert.equal(field(reopened, "state"), "RUNNING");
    await api(`/api/sessions/${sessionId}`, "DELETE");
  });
});
