import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { config } from "@/config";
import { ensureRunning, touch, type Microvm } from "@/registry";
import { verifyToken } from "@/tokens";

const BASE_PROTOCOL = "lambda-microvms";
const AUTH_PREFIX = "lambda-microvms.authentication.";
const PORT_PREFIX = "lambda-microvms.port.";
const AUTH_HEADER = "x-aws-proxy-auth";
const PORT_HEADER = "x-aws-proxy-port";
/** Lifecycle hooks are for the platform agent, never for endpoint clients. */
const HOOK_PREFIX = "/aws/lambda-microvms/";

export function isHookPath(path: string): boolean {
  return path.startsWith(HOOK_PREFIX);
}

type Credentials = {
  token: string | undefined;
  port: number;
  remainingProtocols: string[];
  /** True when the client offered the required `lambda-microvms` base protocol. */
  baseOffered: boolean;
};

/** Pulls the Lambda-specific auth and port out of headers and subprotocols. */
export function extractCredentials(req: http.IncomingMessage): Credentials {
  let token = headerValue(req.headers[AUTH_HEADER]);
  let port = Number(headerValue(req.headers[PORT_HEADER]) ?? config.appPort);
  const remainingProtocols: string[] = [];
  let baseOffered = false;

  const protocolHeader = headerValue(req.headers["sec-websocket-protocol"]);
  if (protocolHeader !== undefined) {
    for (const raw of protocolHeader.split(",")) {
      const protocol = raw.trim();
      if (protocol === BASE_PROTOCOL) {
        baseOffered = true;
        continue;
      }
      if (protocol === "") {
        continue;
      }
      if (protocol.startsWith(AUTH_PREFIX)) {
        token = protocol.slice(AUTH_PREFIX.length);
      } else if (protocol.startsWith(PORT_PREFIX)) {
        port = Number(protocol.slice(PORT_PREFIX.length));
      } else {
        remainingProtocols.push(protocol);
      }
    }
  }
  return { token, port, remainingProtocols, baseOffered };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isProxyHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === AUTH_HEADER || lower === PORT_HEADER;
}

export async function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  microvm: Microvm,
  path: string,
): Promise<void> {
  const { token, port } = extractCredentials(req);
  if (!verifyToken(token, microvm.microvmId, port) || isHookPath(path)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Forbidden" }));
    return;
  }
  touch(microvm);
  const container = await ensureRunning(microvm);
  if (container === null) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `MicroVM is ${microvm.state}` }));
    return;
  }

  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!isProxyHeader(name) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers["host"] = `127.0.0.1:${container.hostPort}`;
  // A pooled socket to a container that gets paused would hang instead of
  // failing, so every proxied request gets its own connection.
  headers["connection"] = "close";

  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: container.hostPort,
      method: req.method,
      path,
      headers,
      agent: false,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    console.warn(`[${microvm.microvmId}] upstream error:`, error.message);
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end();
  });
  req.pipe(upstream);
}

export async function proxyUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  microvm: Microvm,
  path: string,
): Promise<void> {
  const { token, port, remainingProtocols, baseOffered } = extractCredentials(req);
  if (!verifyToken(token, microvm.microvmId, port) || isHookPath(path)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  touch(microvm);
  const container = await ensureRunning(microvm);
  if (container === null) {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }

  const request = rewriteUpgradeRequest(req, path, container.hostPort, remainingProtocols);
  pipeUpgrade(microvm, socket, head, container.hostPort, request, baseOffered);
}

/**
 * Browsers fail the handshake when they offered subprotocols and the server
 * selected none. Lambda answers with the base protocol; so do we.
 */
export function selectBaseProtocol(responseHead: string): string {
  const [statusLine] = responseHead.split("\r\n", 1);
  if (statusLine === undefined || !statusLine.includes(" 101 ")) {
    return responseHead;
  }
  if (/^sec-websocket-protocol:/imu.test(responseHead)) {
    return responseHead;
  }
  return responseHead.replace("\r\n\r\n", `\r\nSec-WebSocket-Protocol: ${BASE_PROTOCOL}\r\n\r\n`);
}

/** Rebuilds the raw upgrade request with Lambda-specific headers removed. */
function rewriteUpgradeRequest(
  req: http.IncomingMessage,
  path: string,
  hostPort: number,
  remainingProtocols: string[],
): string {
  const lines = [`${req.method ?? "GET"} ${path} HTTP/1.1`];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index] ?? "";
    const value = req.rawHeaders[index + 1] ?? "";
    const lower = name.toLowerCase();
    if (isProxyHeader(lower) || lower === "sec-websocket-protocol" || lower === "host") {
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: 127.0.0.1:${hostPort}`);
  if (remainingProtocols.length > 0) {
    lines.push(`Sec-WebSocket-Protocol: ${remainingProtocols.join(", ")}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** Splices the client socket to the container and counts frames as traffic. */
function pipeUpgrade(
  microvm: Microvm,
  socket: Duplex,
  head: Buffer,
  hostPort: number,
  request: string,
  baseOffered: boolean,
): void {
  const upstream = net.connect(hostPort, "127.0.0.1");
  upstream.on("connect", () => {
    upstream.write(request);
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    // Hold the upstream response until its headers are complete so the
    // selected subprotocol can be injected, then splice the rest through.
    let buffered = Buffer.alloc(0);
    const onHeaders = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      upstream.off("data", onHeaders);
      const headText = buffered.subarray(0, end + 4).toString("latin1");
      const rest = buffered.subarray(end + 4);
      socket.write(baseOffered ? selectBaseProtocol(headText) : headText, "latin1");
      if (rest.length > 0) {
        socket.write(rest);
      }
      upstream.pipe(socket);
    };
    upstream.on("data", onHeaders);
  });
  const onTraffic = () => {
    touch(microvm);
  };
  socket.on("data", onTraffic);
  upstream.on("data", onTraffic);
  upstream.on("error", (error) => {
    console.warn(`[${microvm.microvmId}] websocket upstream error:`, error.message);
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });
  upstream.on("close", () => {
    socket.destroy();
  });
}
