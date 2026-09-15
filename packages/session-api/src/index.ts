/**
 * The contract between the controller's session API and its clients: the
 * browser client, the controller itself, and the end-to-end tests all import
 * these types and parsers, so a renamed field fails to compile everywhere at
 * once instead of passing two fake-backed test suites and breaking in a tab.
 */

export type MicrovmState =
  "PENDING" | "RUNNING" | "SUSPENDING" | "SUSPENDED" | "TERMINATING" | "TERMINATED";

const STATES: readonly MicrovmState[] = [
  "PENDING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "TERMINATING",
  "TERMINATED",
];

export type BackendName = "local" | "aws";

/** What `GET /api/sessions/:id` returns: state only, no credentials. */
export type SessionState = {
  sessionId: string;
  microvmId: string;
  createdAt: number;
  state: MicrovmState;
  stateReason: string | null;
  wsUrl: string;
  backend: BackendName;
};

/** What `POST /api/sessions` and `POST /api/sessions/:id/token` return. */
export type SessionInfo = SessionState & {
  token: string;
  expiresAt: number;
};

export function asState(value: unknown): MicrovmState {
  const state = STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new Error(`unknown MicroVM state: ${String(value)}`);
  }
  return state;
}

export function isTerminal(state: MicrovmState): boolean {
  return state === "TERMINATED" || state === "TERMINATING";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") {
    throw new TypeError(`session response is missing "${name}"`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== "number") {
    throw new TypeError(`session response is missing "${name}"`);
  }
  return value;
}

export function parseSessionState(value: unknown): SessionState {
  if (!isRecord(value)) {
    throw new TypeError("session response is not an object");
  }
  const reason = value["stateReason"];
  return {
    sessionId: stringField(value, "sessionId"),
    microvmId: stringField(value, "microvmId"),
    createdAt: numberField(value, "createdAt"),
    state: asState(value["state"]),
    stateReason: typeof reason === "string" ? reason : null,
    wsUrl: stringField(value, "wsUrl"),
    backend: value["backend"] === "aws" ? "aws" : "local",
  };
}

export function parseSessionInfo(value: unknown): SessionInfo {
  const state = parseSessionState(value);
  if (!isRecord(value)) {
    throw new TypeError("session response is not an object");
  }
  return {
    ...state,
    token: stringField(value, "token"),
    expiresAt: numberField(value, "expiresAt"),
  };
}

/** The state-only view of a session, safe to hand to UI code. */
export function withoutToken(info: SessionInfo): SessionState {
  const { token: _token, expiresAt: _expiresAt, ...state } = info;
  return state;
}
