/** Client for the controller's session API, proxied by Vite under /api. */

import {
  parseSessionInfo,
  parseSessionState,
  type MicrovmState,
  type SessionInfo,
  type SessionState,
} from "@workers/session-api";

export type { MicrovmState, SessionInfo, SessionState };

const STORAGE_KEY = "microvm.sessionId";

/** The controller answered 410: the MicroVM behind this session is gone. */
export class SessionGoneError extends Error {
  override readonly name = "SessionGone";
}

async function request(path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (response.status === 410) {
    throw new SessionGoneError(`${method} ${path} -> 410`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}`);
  }
  return response.json();
}

/**
 * Reuses the session from this tab if the controller still knows it. Note that
 * the browser's "duplicate tab" copies sessionStorage, so a duplicated tab
 * attaches to the same MicroVM and "End session" in either tab ends both.
 */
export function rememberedSessionId(): string | undefined {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(sessionId: string | null): void {
  try {
    if (sessionId === null) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, sessionId);
    }
  } catch {
    // storage unavailable; the session simply won't survive a reload
  }
}

/**
 * Opens or reattaches this tab's session. The id is chosen here and stored
 * before the request goes out, so two overlapping calls (React StrictMode
 * mounts twice) carry the same idempotency key and share one MicroVM.
 */
export async function openSession(): Promise<SessionInfo> {
  let sessionId = rememberedSessionId();
  if (sessionId === undefined) {
    sessionId = crypto.randomUUID();
    remember(sessionId);
  }
  const info = parseSessionInfo(await request("/api/sessions", "POST", { sessionId }));
  remember(info.sessionId);
  return info;
}

export async function refreshSession(sessionId: string): Promise<SessionInfo> {
  return parseSessionInfo(await request(`/api/sessions/${sessionId}/token`, "POST"));
}

export async function getSession(sessionId: string): Promise<SessionState> {
  return parseSessionState(await request(`/api/sessions/${sessionId}`, "GET"));
}

/** Terminates first; the tab only forgets the session once the MicroVM is gone. */
export async function closeSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}`, "DELETE");
  remember(null);
}
