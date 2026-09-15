import { setTimeout as sleep } from "node:timers/promises";

import { config } from "@/config";

export const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";

export type Hook = "ready" | "validate" | "run" | "resume" | "suspend" | "terminate";

/** POSTs a lifecycle hook to the app, the way the Lambda agent does. */
export async function postHook(hostPort: number, hook: Hook, body?: unknown): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}${HOOK_PREFIX}/${hook}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
      signal: AbortSignal.timeout(config.hookTimeoutMs),
    });
    if (!response.ok) {
      console.warn(`hook ${hook} returned ${response.status}`);
    }
    return response.ok;
  } catch (error) {
    console.warn(`hook ${hook} failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Mirrors Lambda's image-build wait: the app must answer /health, then the
 * /ready hook, which may return 503 until initialization is complete.
 */
export async function waitForReady(
  hostPort: number,
  timeoutMs: number,
  stillAlive: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await waitForHealth(hostPort, timeoutMs, stillAlive);
  /* oxlint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (await postHook(hostPort, "ready")) {
      return;
    }
    await sleep(250);
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error(`app on port ${hostPort} never answered /ready within ${timeoutMs}ms`);
}

/** Waits until the app answers /health, giving up early if the container dies. */
export async function waitForHealth(
  hostPort: number,
  timeoutMs: number,
  stillAlive: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Sequential polling is the point here.
  /* oxlint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (!(await stillAlive())) {
      throw new Error(`container on port ${hostPort} exited before becoming healthy`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error(`app on port ${hostPort} did not become healthy within ${timeoutMs}ms`);
}
