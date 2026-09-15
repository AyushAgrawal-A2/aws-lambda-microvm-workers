import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { EnvelopeSchema, type Envelope } from "@workers/proto";

export type Listener = (env: Envelope) => void;

function defaultUrl() {
  const override = import.meta.env.VITE_WS_URL;
  if (override !== undefined && override !== "") {
    return override;
  }
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export class WorkerSocket {
  private readonly _url: string;
  private _ws: WebSocket | null = null;
  private _nextId = 1n;
  private readonly _listeners = new Set<Listener>();
  private _closed = true;
  private _heartbeat: number | undefined;

  constructor() {
    this._url = defaultUrl();
  }

  connect() {
    const ws = new WebSocket(this._url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (message) => {
      if (!(message.data instanceof ArrayBuffer)) {
        return;
      }
      const envelope = fromBinary(EnvelopeSchema, new Uint8Array(message.data));
      this._listeners.forEach((listener) => {
        listener(envelope);
      });
    };
    ws.onclose = () => {
      clearInterval(this._heartbeat);
      this._heartbeat = undefined;
      this._ws = null;
      if (!this._closed) {
        setTimeout(() => {
          this.connect();
        }, 1000);
      }
    };
    this._ws = ws;
    this._closed = false;
    this._heartbeat = setInterval(() => {
      this.heartbeat();
    }, 1000);
  }

  send(envelope: Envelope) {
    if (this._ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this._ws.send(toBinary(EnvelopeSchema, envelope));
    return true;
  }

  close() {
    clearInterval(this._heartbeat);
    this._heartbeat = undefined;
    this._closed = true;
    this._ws?.close();
  }

  onMessage(listener: Listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  exec(command: string, stdin = new Uint8Array()) {
    const id = this._nextId++;
    const envelope = create(EnvelopeSchema, {
      id,
      payload: { case: "exec", value: { command, stdin } },
    });
    this.send(envelope);
    return id;
  }

  heartbeat() {
    const envelope = create(EnvelopeSchema, {
      id: this._nextId++,
      payload: { case: "heartbeat", value: { tsMs: BigInt(Date.now()) } },
    });
    this.send(envelope);
  }
}
