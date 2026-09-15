import { useEffect, useRef, useState } from "react";

import type { Envelope } from "@workers/proto";

import { WorkerSocket } from "@/lib/worker-socket";

export function useWorker() {
  const socket = useRef<WorkerSocket | null>(null);
  const [last, setLast] = useState<Envelope | null>(null);

  useEffect(() => {
    const workerSocket = new WorkerSocket();
    const off = workerSocket.onMessage(setLast);
    workerSocket.connect();
    socket.current = workerSocket;
    return () => {
      off();
      workerSocket.close();
    };
  }, []);

  return {
    last,
    exec: (command: string) => socket.current?.exec(command),
    heartbeat: () => socket.current?.heartbeat(),
  };
}
