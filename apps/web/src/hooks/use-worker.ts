import { useEffect, useRef, useState } from "react";

import type { Envelope } from "@workers/proto";

import { getSession, type SessionState } from "@/lib/session";
import { WorkerSocket, type Status } from "@/lib/worker-socket";

const SESSION_POLL_MS = 2000;

/** Polls the MicroVM state so suspend and resume are visible in the UI. */
function useSessionPolling(
  sessionId: string | null,
  setSession: (update: (current: SessionState | null) => SessionState | null) => void,
): void {
  useEffect(() => {
    if (sessionId === null) {
      return;
    }
    const poll = async () => {
      try {
        const info = await getSession(sessionId);
        setSession((current) => (current?.sessionId === sessionId ? info : current));
      } catch {
        // controller unreachable or session gone; the socket will report it
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, SESSION_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [sessionId, setSession]);
}

export function useWorker() {
  const socket = useRef<WorkerSocket | null>(null);
  const [last, setLast] = useState<Envelope | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => {
    const workerSocket = new WorkerSocket();
    const offMessage = workerSocket.onMessage((envelope) => {
      if (envelope.payload.case !== "heartbeat") {
        setLast(envelope);
      }
    });
    const offStatus = workerSocket.onStatus((next, info) => {
      setStatus(next);
      setSession(info);
    });
    void workerSocket.connect();
    socket.current = workerSocket;
    return () => {
      offMessage();
      offStatus();
      workerSocket.close();
    };
  }, []);

  useSessionPolling(session?.sessionId ?? null, setSession);

  return {
    last,
    status,
    session,
    exec: (command: string) => socket.current?.exec(command),
    heartbeat: () => socket.current?.heartbeat(),
    endSession: () => socket.current?.endSession(),
    retry: () => socket.current?.retry(),
  };
}
