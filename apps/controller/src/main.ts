import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";

import type { Backend } from "@/backend";
import { awsBackend } from "@/backends/aws";
import { localBackend } from "@/backends/local";
import { config } from "@/config";
import {
  closeSession,
  describeSession,
  getSession,
  openSession,
  reconcileSessions,
  refreshSession,
  SessionGoneError,
  SessionQuotaError,
  type Session,
} from "@/sessions";

const backend: Backend = config.backend === "aws" ? awsBackend : localBackend;

/** Session ids are UUIDs; anything else is rejected before it reaches a backend. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Rejects Host headers that are not this machine, defeating DNS rebinding. */
const requireKnownHost = createMiddleware(async (context, next) => {
  const raw = context.req.header("host") ?? "";
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  if (hostname === undefined || !config.allowedHosts.has(hostname)) {
    console.warn(`rejected request with Host "${raw}" (possible DNS rebinding)`);
    throw new HTTPException(421, { message: "Host not allowed" });
  }
  await next();
});

/**
 * Mutations must be JSON. A cross-origin page can send a text/plain POST to
 * localhost without a preflight; requiring JSON forces one, and the absent
 * CORS headers then block it.
 */
const requireJson = createMiddleware(async (context, next) => {
  const method = context.req.method;
  const contentType = context.req.header("content-type") ?? "";
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new HTTPException(415, { message: "content-type must be application/json" });
  }
  await next();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Like `context.req.json()` but tolerates an empty body. */
async function optionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "body is not valid JSON" });
  }
  return isRecord(parsed) ? parsed : {};
}

function requireSession(sessionId: string): Session {
  const session = getSession(sessionId);
  if (session === undefined) {
    throw new HTTPException(404, { message: "no such session" });
  }
  return session;
}

const sessions = new Hono()
  .use(requireJson)
  .post("/", async (context) => {
    const body = await optionalJson(context.req.raw);
    const requested = body["sessionId"];
    if (requested !== undefined && (typeof requested !== "string" || !SESSION_ID.test(requested))) {
      throw new HTTPException(400, { message: "sessionId must be a UUID" });
    }
    const info = await openSession(backend, requested);
    return context.json(info);
  })
  .get("/:id{[0-9a-f-]+}", async (context) => {
    const session = requireSession(context.req.param("id"));
    return context.json(await describeSession(backend, session));
  })
  .post("/:id{[0-9a-f-]+}/token", async (context) => {
    const session = requireSession(context.req.param("id"));
    return context.json(await refreshSession(backend, session));
  })
  .delete("/:id{[0-9a-f-]+}", async (context) => {
    const session = requireSession(context.req.param("id"));
    await closeSession(backend, session);
    return context.json({ sessionId: session.sessionId, state: "TERMINATED" });
  });

const app = new Hono()
  .use(logger())
  .use(requireKnownHost)
  .get("/health", (context) => context.json({ status: "ok", backend: backend.name }))
  .route("/api/sessions", sessions)
  .notFound((context) => context.json({ message: "not found" }, 404))
  .onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ message: error.message }, error.status);
    }
    if (error instanceof SessionQuotaError) {
      return context.json({ message: error.name, detail: error.message }, 402);
    }
    if (error instanceof SessionGoneError) {
      return context.json({ message: error.name, detail: error.message }, 410);
    }
    console.error("request failed:", error.message, error.cause === undefined ? "" : error.cause);
    return context.json({ message: error.message }, 500);
  });

const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`controller on http://127.0.0.1:${info.port} using ${backend.name} backend`);
});

const reconciler = setInterval(() => {
  reconcileSessions(backend).catch((error: unknown) => {
    console.error("reconcile failed:", error);
  });
}, config.reconcileIntervalMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(reconciler);
    server.close();
    process.exit(0);
  });
}
