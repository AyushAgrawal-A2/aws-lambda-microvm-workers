import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { isTerminal, type SessionInfo, type SessionState } from "@workers/session-api";

import { MicrovmNotFoundError, type Backend, type MicrovmView } from "@/backend";
import { config } from "@/config";

export type { SessionInfo, SessionState };

export type Session = {
  sessionId: string;
  microvmId: string;
  createdAt: number;
};

const sessions = new Map<string, Session>();
/** Ids whose MicroVM is being run right now; they count against the quota. */
const reservations = new Set<string>();

function liveSessionCount(): number {
  return sessions.size + reservations.size;
}

/** Thrown when the session cap is reached; the API maps it to 402 like AWS. */
export class SessionQuotaError extends Error {
  override readonly name = "ServiceQuotaExceededException";
}

/** The session's MicroVM is gone; the API maps it to 410 and the client reopens. */
export class SessionGoneError extends Error {
  override readonly name = "SessionGone";
}

/** Looks the MicroVM up; a terminal or unknown one drops the session and throws Gone. */
async function liveView(backend: Backend, session: Session): Promise<MicrovmView> {
  let view: MicrovmView;
  try {
    view = await backend.get(session.microvmId);
  } catch (error) {
    if (error instanceof MicrovmNotFoundError) {
      sessions.delete(session.sessionId);
      throw new SessionGoneError(`MicroVM ${session.microvmId} is no longer known`);
    }
    throw error;
  }
  if (isTerminal(view.state)) {
    sessions.delete(session.sessionId);
    throw new SessionGoneError(`MicroVM ${session.microvmId} is ${view.state}`);
  }
  return view;
}

/** Session ids are bearer credentials; logs get a prefix only. */
function redact(sessionId: string): string {
  return `${sessionId.slice(0, 8)}…`;
}

async function waitUntilRunning(backend: Backend, view: MicrovmView): Promise<MicrovmView> {
  const deadline = Date.now() + config.readyTimeoutMs;
  let current = view;
  /* oxlint-disable no-await-in-loop */
  while (current.state === "PENDING" && Date.now() < deadline) {
    await sleep(250);
    current = await backend.get(current.microvmId);
  }
  /* oxlint-enable no-await-in-loop */
  if (current.state === "TERMINATED" || current.state === "TERMINATING") {
    throw new Error(`MicroVM ${current.microvmId} terminated: ${current.stateReason ?? "unknown"}`);
  }
  if (current.state === "PENDING") {
    throw new Error(`MicroVM ${current.microvmId} did not reach RUNNING in time`);
  }
  return current;
}

/** Reads state only. No token is minted, so this is cheap enough to poll. */
export async function describeSession(backend: Backend, session: Session): Promise<SessionState> {
  const view = await liveView(backend, session);
  return {
    ...session,
    state: view.state,
    stateReason: view.stateReason,
    wsUrl: backend.wsUrl(view.endpoint, "/ws"),
    backend: backend.name,
  };
}

/** State plus a new token. Every call is a CreateMicrovmAuthToken against AWS. */
async function describeWithToken(backend: Backend, session: Session): Promise<SessionInfo> {
  const state = await describeSession(backend, session);
  const auth = await backend.createToken(session.microvmId, config.tokenMinutes);
  return { ...state, token: auth.token, expiresAt: auth.expiresAt };
}

/**
 * Returns an existing live session or runs a new MicroVM for it. The session id
 * doubles as the run's idempotency token.
 */
export async function openSession(backend: Backend, requestedId?: string): Promise<SessionInfo> {
  const existing = requestedId === undefined ? undefined : sessions.get(requestedId);
  if (existing !== undefined) {
    try {
      await liveView(backend, existing);
      return await describeWithToken(backend, existing);
    } catch (error) {
      if (!(error instanceof SessionGoneError)) {
        throw error;
      }
      // fall through: the old MicroVM is gone, run a fresh one under the same id
    }
  }

  if (liveSessionCount() >= config.maxSessions) {
    await reconcileSessions(backend);
  }
  if (liveSessionCount() >= config.maxSessions) {
    throw new SessionQuotaError(
      `session quota of ${config.maxSessions} reached; end a session or raise MICROVM_MAX_SESSIONS`,
    );
  }
  const sessionId = requestedId ?? randomUUID();
  // Hold the slot while the MicroVM starts so concurrent opens cannot all
  // pass the quota check before any of them is recorded.
  reservations.add(sessionId);
  let session: Session;
  try {
    const started = await backend.run(sessionId, JSON.stringify({ sessionId }));
    await waitUntilRunning(backend, started);
    session = { sessionId, microvmId: started.microvmId, createdAt: Date.now() };
    sessions.set(sessionId, session);
  } finally {
    reservations.delete(sessionId);
  }
  console.log(`session ${redact(sessionId)} -> ${session.microvmId} (${backend.name})`);
  return describeWithToken(backend, session);
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function refreshSession(backend: Backend, session: Session): Promise<SessionInfo> {
  return describeWithToken(backend, session);
}

/** Terminates first; the record is only forgotten once the MicroVM is gone. */
export async function closeSession(backend: Backend, session: Session): Promise<void> {
  try {
    await backend.terminate(session.microvmId);
  } catch (error) {
    if (!(error instanceof MicrovmNotFoundError)) {
      throw error;
    }
  }
  sessions.delete(session.sessionId);
  console.log(`session ${redact(session.sessionId)} terminated ${session.microvmId}`);
}

/**
 * Drops sessions whose MicroVM terminated on its own (idle policy, reaper,
 * maximum duration) or was evicted. Runs on a timer and before the quota is
 * enforced, so dead sessions never count against it.
 */
let lastReconcileAt = 0;
let reconcileInFlight: Promise<number> | null = null;

export function reconcileSessions(backend: Backend): Promise<number> {
  // One reconcile at a time, and never more often than the minimum interval:
  // a burst of quota-rejected opens must not turn into a burst of backend calls.
  if (reconcileInFlight !== null) {
    return reconcileInFlight;
  }
  if (Date.now() - lastReconcileAt < config.reconcileMinIntervalMs) {
    return Promise.resolve(0);
  }
  lastReconcileAt = Date.now();
  reconcileInFlight = reconcileNow(backend).finally(() => {
    reconcileInFlight = null;
  });
  return reconcileInFlight;
}

async function reconcileNow(backend: Backend): Promise<number> {
  let dropped = 0;
  /* oxlint-disable no-await-in-loop -- sequential on purpose; keeps backend load flat */
  for (const session of sessions.values()) {
    try {
      await liveView(backend, session);
    } catch (error) {
      if (error instanceof SessionGoneError) {
        dropped += 1;
        console.log(`session ${redact(session.sessionId)} dropped: ${error.message}`);
      } else {
        console.warn(`reconcile skipped ${redact(session.sessionId)}:`, error);
      }
    }
  }
  /* oxlint-enable no-await-in-loop */
  return dropped;
}
