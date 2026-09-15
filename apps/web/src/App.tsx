import { useState } from "react";

import { useWorker } from "@/hooks/use-worker";
import { describe } from "@/lib/envelope";

export function App() {
  const { last, exec, heartbeat } = useWorker();
  const [command, setCommand] = useState("echo hi");

  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <input
        value={command}
        onChange={(e) => {
          setCommand(e.target.value);
        }}
      />

      <button
        onClick={() => {
          exec(command);
        }}
      >
        Run
      </button>

      <button onClick={heartbeat}>Heartbeat</button>

      <pre>{last ? `id=${last.id}\n${describe(last)}` : "no messages yet"}</pre>
    </main>
  );
}
