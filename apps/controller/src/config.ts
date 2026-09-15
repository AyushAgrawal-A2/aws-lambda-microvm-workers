function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const region = env("AWS_REGION", env("AWS_DEFAULT_REGION", "us-east-1"));

function backendName(): "local" | "aws" {
  const value = env("MICROVM_BACKEND", "local");
  if (value === "local" || value === "aws") {
    return value;
  }
  throw new Error(`MICROVM_BACKEND must be "local" or "aws", got "${value}"`);
}

function allowedHosts(): Set<string> {
  const extra = env("CONTROLLER_ALLOWED_HOSTS", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return new Set(["localhost", "127.0.0.1", "[::1]", ...extra]);
}

export const config = {
  port: Number(env("CONTROLLER_PORT", "4600")),
  /** Host header values accepted; anything else is a DNS-rebinding attempt. */
  allowedHosts: allowedHosts(),
  /** How often sessions are checked against the backend and dead ones dropped. */
  reconcileIntervalMs: Number(env("MICROVM_RECONCILE_INTERVAL_MS", "30000")),
  /** Floor between reconciles, however many quota-rejected opens ask for one. */
  reconcileMinIntervalMs: Number(env("MICROVM_RECONCILE_MIN_INTERVAL_MS", "5000")),
  /** `local` talks to apps/local-gateway; `aws` talks to Lambda MicroVMs (or Floci). */
  backend: backendName(),

  local: {
    gatewayUrl: env("LOCAL_GATEWAY_URL", "http://127.0.0.1:4590"),
  },

  aws: {
    region,
    imageIdentifier: env("MICROVM_IMAGE_ARN", ""),
    executionRoleArn: process.env["MICROVM_EXECUTION_ROLE_ARN"],
    ingressConnector: env(
      "MICROVM_INGRESS_CONNECTOR",
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    ),
    egressConnector: env(
      "MICROVM_EGRESS_CONNECTOR",
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    ),
  },

  idlePolicy: {
    autoResumeEnabled: true,
    maxIdleDurationSeconds: Number(env("MICROVM_MAX_IDLE_SECONDS", "900")),
    suspendedDurationSeconds: Number(env("MICROVM_SUSPENDED_SECONDS", "1800")),
  },
  maximumDurationInSeconds: Number(env("MICROVM_MAX_DURATION_SECONDS", "14400")),
  tokenMinutes: Number(env("MICROVM_TOKEN_MINUTES", "30")),
  /** Upper bound on live sessions this controller will hold. */
  maxSessions: Number(env("MICROVM_MAX_SESSIONS", "8")),
  /** How long to wait for a MicroVM to reach RUNNING after run. */
  readyTimeoutMs: Number(env("MICROVM_READY_TIMEOUT_MS", "60000")),
  /** Port the worker listens on inside the MicroVM. */
  appPort: Number(env("WORKER_APP_PORT", "8080")),
} as const;
