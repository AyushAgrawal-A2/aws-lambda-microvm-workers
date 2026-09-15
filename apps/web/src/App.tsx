import { useState } from "react";

import { useWorker } from "@/hooks/use-worker";
import { describe } from "@/lib/envelope";

export function App() {
  const { last, status, session, exec, heartbeat, endSession, retry } = useWorker();
  const [command, setCommand] = useState("echo hi");
  const connected = status === "open";

  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <p>
        socket: <b>{status}</b>
        {session === null ? null : (
          <>
            {" | "}microvm: <b>{session.state}</b> ({session.backend}) {session.microvmId}
          </>
        )}
      </p>

      <input
        value={command}
        onChange={(event) => {
          setCommand(event.target.value);
        }}
      />

      <button
        disabled={!connected}
        onClick={() => {
          exec(command);
        }}
      >
        Run
      </button>

      <button disabled={!connected} onClick={heartbeat}>
        Heartbeat
      </button>

      <button
        disabled={session === null}
        onClick={() => {
          void endSession();
        }}
      >
        End session
      </button>

      {status === "failed" ? <button onClick={retry}>Retry</button> : null}

      <pre>{last ? `id=${last.messageId}\n${describe(last)}` : "no messages yet"}</pre>
    </main>
  );
}
