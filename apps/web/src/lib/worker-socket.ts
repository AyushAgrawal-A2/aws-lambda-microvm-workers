import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { EnvelopeSchema, type Envelope } from "@workers/proto";
import { withoutToken, type SessionState } from "@workers/session-api";

import {
  closeSession,
  openSession,
  refreshSession,
  SessionGoneError,
  type SessionInfo,
} from "@/lib/session";

export type Listener = (env: Envelope) => void;
export type Status =
  "idle" | "starting" | "connecting" | "open" | "reconnecting" | "closed" | "failed";
/** Listeners see the session without its token; the token stays in this class. */
export type StatusListener = (status: Status, session: SessionState | null) => void;

const HEARTBEAT_MS = 30_000;
/** Reconnect delays double from here, capped, then give up. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_ATTEMPTS = 8;

/** Lambda MicroVMs subprotocols carrying auth and target port. */
function subprotocols(token: string, port: number): string[] {
  return [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${port}`,
  ];
}

/**
 * Direct mode: VITE_WS_URL points straight at a worker (the plain `pnpm dev`
 * flow) and no session is involved. Relative values resolve against the page.
 */
function directUrl(): string | null {
  // `import.meta.env` is undefined outside Vite (unit tests run under Node).
  const override = (import.meta.env as ImportMetaEnv | undefined)?.VITE_WS_URL;
  if (override === undefined || override === "") {
    return null;
  }
  if (override.startsWith("/")) {
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${override}`;
  }
  return override;
}

export class WorkerSocket {
  private _socket: WebSocket | null = null;
  private _nextId = 1n;
  private readonly _listeners = new Set<Listener>();
  private readonly _statusListeners = new Set<StatusListener>();
  private _closed = true;
  private _heartbeat: ReturnType<typeof setInterval> | undefined;
  private _session: SessionInfo | null = null;
  private _status: Status = "idle";
  private _attempts = 0;
  private readonly _onVisible = () => {
    if (document.visibilityState === "visible") {
      this.heartbeat();
    }
  };

  get session(): SessionState | null {
    return this._session === null ? null : withoutToken(this._session);
  }

  get status(): Status {
    return this._status;
  }

  /** Opens the connection, running a session through the controller unless in direct mode. */
  async connect(): Promise<void> {
    this._closed = false;
    const direct = directUrl();
    if (direct !== null) {
      this.open(direct, []);
      return;
    }
    this.setStatus("starting");
    let session: SessionInfo;
    try {
      session = await openSession();
    } catch (error) {
      console.error("session open failed:", error);
      this.scheduleReconnect();
      return;
    }
    // close() may have run while the session was being opened.
    if (this._closed) {
      return;
    }
    this._session = session;
    this.open(session.wsUrl, subprotocols(session.token, 8080));
  }

  private open(url: string, protocols: string[]): void {
    this.setStatus(this._status === "reconnecting" ? "reconnecting" : "connecting");
    const socket = new WebSocket(url, protocols);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this._attempts = 0;
      this.setStatus("open");
      this._heartbeat = setInterval(() => {
        this.heartbeat();
      }, HEARTBEAT_MS);
      // Hidden tabs throttle timers; send a beat as soon as the tab is back.
      document.addEventListener("visibilitychange", this._onVisible);
    };
    socket.onmessage = (message) => {
      if (!(message.data instanceof ArrayBuffer)) {
        return;
      }
      const envelope = fromBinary(EnvelopeSchema, new Uint8Array(message.data));
      this._listeners.forEach((listener) => {
        listener(envelope);
      });
    };
    socket.onclose = (event) => {
      clearInterval(this._heartbeat);
      this._heartbeat = undefined;
      document.removeEventListener("visibilitychange", this._onVisible);
      this._socket = null;
      if (!event.wasClean) {
        console.warn(`socket closed abnormally (${event.code}) ${event.reason}`);
      }
      if (this._closed) {
        this.setStatus("closed");
      } else {
        this.scheduleReconnect();
      }
    };
    this._socket = socket;
  }

  private scheduleReconnect(): void {
    if (this._closed) {
      return;
    }
    if (this._attempts >= RECONNECT_ATTEMPTS) {
      console.error(`giving up after ${RECONNECT_ATTEMPTS} reconnect attempts`);
      this.setStatus("failed");
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._attempts, RECONNECT_MAX_MS);
    this._attempts += 1;
    this.setStatus("reconnecting");
    setTimeout(() => {
      void this.reconnect();
    }, delay);
  }

  /** Reconnects with a fresh token; a suspended MicroVM auto-resumes on the first frame. */
  private async reconnect(): Promise<void> {
    if (this._closed) {
      return;
    }
    const direct = directUrl();
    if (direct !== null) {
      this.open(direct, []);
      return;
    }
    let session: SessionInfo;
    try {
      // openSession reuses the remembered id, so a retry can never run a
      // second MicroVM for this tab.
      session =
        this._session === null
          ? await openSession()
          : await refreshSession(this._session.sessionId);
    } catch (error) {
      if (error instanceof SessionGoneError) {
        // The MicroVM died. Forget it so the next attempt reopens under the
        // remembered id, which the controller replaces with a fresh MicroVM.
        console.warn("session gone, reopening:", error.message);
        this._session = null;
      } else {
        console.warn("session refresh failed:", error);
      }
      this.scheduleReconnect();
      return;
    }
    if (this._closed) {
      return;
    }
    this._session = session;
    this.open(session.wsUrl, subprotocols(session.token, 8080));
  }

  send(envelope: Envelope): boolean {
    if (this._socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this._socket.send(toBinary(EnvelopeSchema, envelope));
    return true;
  }

  /** After `failed`, starts the reconnect cycle over from a clean counter. */
  retry(): void {
    if (this._status !== "failed") {
      return;
    }
    this._attempts = 0;
    this._closed = false;
    this.scheduleReconnect();
  }

  /** Closes the socket. The MicroVM stays alive and will idle-suspend on its own. */
  close(): void {
    clearInterval(this._heartbeat);
    this._heartbeat = undefined;
    this._closed = true;
    this._socket?.close(1000, "client closed");
    this.setStatus("closed");
  }

  /** Closes the socket and terminates the MicroVM behind it. */
  async endSession(): Promise<void> {
    const session = this._session;
    this.close();
    this._session = null;
    if (session !== null) {
      await closeSession(session.sessionId);
    }
    this.setStatus("closed");
  }

  onMessage(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this._statusListeners.add(listener);
    return () => {
      this._statusListeners.delete(listener);
    };
  }

  private setStatus(status: Status): void {
    this._status = status;
    const session = this.session;
    this._statusListeners.forEach((listener) => {
      listener(status, session);
    });
  }

  exec(command: string, stdin = new Uint8Array()): bigint {
    const messageId = this._nextId++;
    const envelope = create(EnvelopeSchema, {
      messageId,
      payload: { case: "exec", value: { command, stdin } },
    });
    this.send(envelope);
    return messageId;
  }

  heartbeat(): void {
    const envelope = create(EnvelopeSchema, {
      messageId: this._nextId++,
      payload: { case: "heartbeat", value: { tsMs: BigInt(Date.now()) } },
    });
    this.send(envelope);
  }
}
