import http from "node:http";

import { config } from "@/config";
import { removeStaleContainers } from "@/docker";
import { proxyHttp, proxyUpgrade } from "@/proxy";
import {
  CONTAINER_LABEL,
  CONTAINER_OWNER,
  describe,
  getMicrovm,
  listMicrovms,
  QuotaExceededError,
  resumeMicrovm,
  runMicrovm,
  suspendMicrovm,
  sweep,
  terminateAll,
  terminateMicrovm,
  type Microvm,
  type RunOptions,
} from "@/registry";
import { issueToken, type AllowedPorts } from "@/tokens";

const vmPath = /^\/mvm\/(mvm-[0-9a-f-]+)(\/.*)?$/u;
const apiPath = /^\/microvms(?:\/(mvm-[0-9a-f-]+)(?:\/(suspend|resume|terminate|auth-token))?)?$/u;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Rejects Host headers that are not this machine, defeating DNS rebinding. */
function hostAllowed(req: http.IncomingMessage): boolean {
  const raw = req.headers.host ?? "";
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  return hostname !== undefined && config.allowedHosts.has(hostname);
}

/**
 * Mutations must carry a JSON content type. A browser can send a text/plain
 * POST to localhost from any origin without a preflight; requiring JSON turns
 * that into a preflighted request, which the missing CORS headers then block.
 */
function isJsonRequest(req: http.IncomingMessage): boolean {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return true;
  }
  return (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRunOptions(body: Json): RunOptions {
  const options: RunOptions = {};
  const clientToken = optionalString(body["clientToken"]);
  const runHookPayload = optionalString(body["runHookPayload"]);
  const maximumDurationInSeconds = optionalNumber(body["maximumDurationInSeconds"]);
  if (clientToken !== undefined) {
    options.clientToken = clientToken;
  }
  if (runHookPayload !== undefined) {
    options.runHookPayload = runHookPayload;
  }
  if (maximumDurationInSeconds !== undefined) {
    options.maximumDurationInSeconds = maximumDurationInSeconds;
  }
  const idle = body["idlePolicy"];
  if (isRecord(idle)) {
    options.idlePolicy = {};
    const maxIdle = optionalNumber(idle["maxIdleDurationSeconds"]);
    const suspended = optionalNumber(idle["suspendedDurationSeconds"]);
    if (typeof idle["autoResumeEnabled"] === "boolean") {
      options.idlePolicy.autoResumeEnabled = idle["autoResumeEnabled"];
    }
    if (maxIdle !== undefined) {
      options.idlePolicy.maxIdleDurationSeconds = maxIdle;
    }
    if (suspended !== undefined) {
      options.idlePolicy.suspendedDurationSeconds = suspended;
    }
  }
  return options;
}

function parseAllowedPorts(value: unknown): AllowedPorts[] {
  if (!Array.isArray(value)) {
    return [{ allPorts: {} }];
  }
  const rules: AllowedPorts[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const port = optionalNumber(entry["port"]);
    const range = entry["range"];
    if ("allPorts" in entry) {
      rules.push({ allPorts: {} });
    } else if (port !== undefined) {
      rules.push({ port });
    } else if (isRecord(range)) {
      const startPort = optionalNumber(range["startPort"]);
      const endPort = optionalNumber(range["endPort"]);
      if (startPort !== undefined && endPort !== undefined) {
        rules.push({ range: { startPort, endPort } });
      }
    }
  }
  return rules.length > 0 ? rules : [{ allPorts: {} }];
}

async function handleCollection(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "POST") {
    const microvm = runMicrovm(parseRunOptions(await readJson(req)));
    json(res, 200, describe(microvm));
  } else if (req.method === "GET") {
    json(res, 200, { microvms: listMicrovms().map((microvm) => describe(microvm)) });
  } else {
    json(res, 405, { message: "method not allowed" });
  }
}

async function handleAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  microvm: Microvm,
  action: string,
) {
  switch (action) {
    case "suspend":
      await suspendMicrovm(microvm);
      break;
    case "resume":
      await resumeMicrovm(microvm);
      break;
    case "terminate":
      await terminateMicrovm(microvm);
      break;
    case "auth-token": {
      if (microvm.state === "TERMINATED" || microvm.state === "TERMINATING") {
        json(res, 404, { message: "ResourceNotFoundException", resourceId: microvm.microvmId });
        return;
      }
      const body = await readJson(req);
      const minutes = optionalNumber(body["expirationInMinutes"]) ?? 30;
      const { token, expiresAt } = issueToken(
        microvm.microvmId,
        minutes,
        parseAllowedPorts(body["allowedPorts"]),
      );
      json(res, 200, { authToken: { "X-aws-proxy-auth": token }, expiresAt });
      return;
    }
    default:
      json(res, 404, { message: "unknown action" });
      return;
  }
  json(res, 200, describe(microvm));
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
): Promise<void> {
  const [, microvmId, action] = match;
  if (!isJsonRequest(req)) {
    json(res, 415, { message: "content-type must be application/json" });
    return;
  }
  if (microvmId === undefined) {
    await handleCollection(req, res);
    return;
  }
  const microvm = getMicrovm(microvmId);
  if (microvm === undefined) {
    json(res, 404, { message: "ResourceNotFoundException", resourceId: microvmId });
    return;
  }
  if (action !== undefined) {
    if (req.method !== "POST") {
      json(res, 405, { message: "method not allowed" });
      return;
    }
    await handleAction(req, res, microvm, action);
    return;
  }
  if (req.method === "GET") {
    json(res, 200, describe(microvm));
  } else if (req.method === "DELETE") {
    await terminateMicrovm(microvm);
    json(res, 200, describe(microvm));
  } else {
    json(res, 405, { message: "method not allowed" });
  }
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) {
    json(res, 421, { message: "Host not allowed" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");

  const proxied = vmPath.exec(url.pathname);
  if (proxied !== null) {
    const [, microvmId, rest] = proxied;
    const microvm = microvmId === undefined ? undefined : getMicrovm(microvmId);
    if (microvm === undefined) {
      json(res, 404, { message: "no such MicroVM" });
      return;
    }
    proxyHttp(req, res, microvm, `${rest ?? "/"}${url.search}`).catch((error: unknown) => {
      console.error(`[${microvm.microvmId}] proxy error:`, error);
      if (!res.headersSent) {
        json(res, 502, { message: "proxy failure" });
      } else {
        res.end();
      }
    });
    return;
  }

  const api = apiPath.exec(url.pathname);
  if (api !== null) {
    handleApi(req, res, api).catch((error: unknown) => {
      if (error instanceof QuotaExceededError) {
        json(res, 402, { message: error.name, detail: error.message });
        return;
      }
      console.error("api error:", error);
      if (!res.headersSent) {
        json(res, 500, { message: error instanceof Error ? error.message : "internal error" });
      }
    });
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, { status: "ok", microvms: listMicrovms().length });
    return;
  }
  json(res, 404, { message: "not found" });
});

server.on("upgrade", (req, socket, head) => {
  if (!hostAllowed(req)) {
    socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const proxied = vmPath.exec(url.pathname);
  const microvmId = proxied?.[1];
  const microvm = microvmId === undefined ? undefined : getMicrovm(microvmId);
  if (proxied === null || microvm === undefined) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  proxyUpgrade(req, socket, head, microvm, `${proxied[2] ?? "/"}${url.search}`).catch(
    (error: unknown) => {
      console.error(`[${microvm.microvmId}] upgrade proxy error:`, error);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    },
  );
});

async function shutdown(signal: string, timer: NodeJS.Timeout): Promise<void> {
  console.log(`${signal} received, terminating MicroVMs`);
  clearInterval(timer);
  server.close();
  try {
    await terminateAll("gateway shutdown");
  } finally {
    process.exit(0);
  }
}

const removed = await removeStaleContainers(CONTAINER_LABEL, CONTAINER_OWNER);
if (removed > 0) {
  console.log(`removed ${removed} stale container(s)`);
}
const sweeper = setInterval(sweep, 1000);

server.listen(config.port, config.host, () => {
  console.log(
    `local microvm gateway on http://${config.host}:${config.port} (image ${config.image})`,
  );
});
process.on("SIGINT", () => {
  void shutdown("SIGINT", sweeper);
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM", sweeper);
});
