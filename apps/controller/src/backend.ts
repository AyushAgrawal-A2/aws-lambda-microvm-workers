import { asState, isTerminal, type BackendName, type MicrovmState } from "@workers/session-api";

export { asState, isTerminal };
export type { MicrovmState };

export type MicrovmView = {
  microvmId: string;
  state: MicrovmState;
  endpoint: string;
  stateReason: string | null;
};

export type AuthToken = { token: string; expiresAt: number };

/** The backend no longer knows this MicroVM: evicted, or never existed. */
export class MicrovmNotFoundError extends Error {
  override readonly name = "ResourceNotFoundException";
}

/** The subset of the Lambda MicroVMs API the controller needs. */
export type Backend = {
  readonly name: BackendName;
  run(clientToken: string, runHookPayload: string): Promise<MicrovmView>;
  get(microvmId: string): Promise<MicrovmView>;
  createToken(microvmId: string, expirationInMinutes: number): Promise<AuthToken>;
  terminate(microvmId: string): Promise<void>;
  /** Builds the URL a browser should open for the given endpoint and path. */
  wsUrl(endpoint: string, path: string): string;
};
