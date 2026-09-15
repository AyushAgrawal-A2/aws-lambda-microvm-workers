import type { Envelope } from "@workers/proto";

export function describe(envelope: Envelope): string {
  switch (envelope.payload.case) {
    case "result":
      return new TextDecoder().decode(envelope.payload.value.stdout);
    case "heartbeat":
      return `heartbeat ${envelope.payload.value.tsMs}`;
    case "exec":
      return `exec ${envelope.payload.value.command}`;
    case undefined:
      return "";
  }
}
