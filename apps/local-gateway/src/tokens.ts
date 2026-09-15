import { randomBytes } from "node:crypto";

export type AllowedPorts =
  | { allPorts: Record<string, never> }
  | { port: number }
  | { range: { startPort: number; endPort: number } };

type TokenRecord = {
  microvmId: string;
  expiresAt: number;
  allowedPorts: AllowedPorts[];
};

const tokens = new Map<string, TokenRecord>();

export function issueToken(
  microvmId: string,
  expirationInMinutes: number,
  allowedPorts: AllowedPorts[],
): { token: string; expiresAt: number } {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + expirationInMinutes * 60_000;
  tokens.set(token, { microvmId, expiresAt, allowedPorts });
  return { token, expiresAt };
}

/** Drops tokens past their expiry so unused ones do not pile up. */
export function pruneExpiredTokens(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [token, record] of tokens) {
    if (record.expiresAt < now) {
      tokens.delete(token);
      pruned += 1;
    }
  }
  return pruned;
}

export function revokeTokens(microvmId: string): void {
  for (const [token, record] of tokens) {
    if (record.microvmId === microvmId) {
      tokens.delete(token);
    }
  }
}

function portAllowed(rule: AllowedPorts, port: number): boolean {
  if ("allPorts" in rule) {
    return true;
  }
  if ("port" in rule) {
    return rule.port === port;
  }
  return port >= rule.range.startPort && port <= rule.range.endPort;
}

/** Returns true when the token is valid for this VM and port. */
export function verifyToken(token: string | undefined, microvmId: string, port: number): boolean {
  if (token === undefined) {
    return false;
  }
  const record = tokens.get(token);
  if (record === undefined || record.microvmId !== microvmId) {
    return false;
  }
  if (record.expiresAt < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return record.allowedPorts.some((rule) => portAllowed(rule, port));
}
