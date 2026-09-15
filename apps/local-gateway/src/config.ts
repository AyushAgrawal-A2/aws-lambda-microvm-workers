export type IdlePolicy = {
  autoResumeEnabled: boolean;
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
};

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const host = env("GATEWAY_HOST", "127.0.0.1");

export const config = {
  /** Interface to bind. Loopback by default: the control API can start containers. */
  host,
  /** Port the gateway listens on for both its control API and per-VM proxying. */
  port: Number(env("GATEWAY_PORT", "4590")),
  /** Host advertised in endpoints handed back to callers; matches the bind by default. */
  publicHost: env("GATEWAY_PUBLIC_HOST", host),
  /**
   * Host header values accepted. Anything else is a DNS-rebinding attempt: a
   * page whose name resolves to this machine would otherwise be same-origin.
   */
  allowedHosts: new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    host,
    env("GATEWAY_PUBLIC_HOST", host),
    ...env("GATEWAY_ALLOWED_HOSTS", "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  ]),
  /** The only image the gateway will run. Callers cannot choose another. */
  image: env("WORKER_IMAGE", "microvm-worker:dev"),
  /** Container limits, mirroring a MicroVM baseline of 2 GB / 1 vCPU. */
  limits: {
    memory: env("GATEWAY_VM_MEMORY", "2g"),
    cpus: env("GATEWAY_VM_CPUS", "1"),
    pids: Number(env("GATEWAY_VM_PIDS", "512")),
  },
  /** Upper bound on MicroVMs that are not TERMINATED; mirrors the AWS memory quota. */
  maxMicrovms: Number(env("GATEWAY_MAX_MICROVMS", "8")),
  /** How often to confirm containers are still alive. */
  livenessIntervalMs: Number(env("GATEWAY_LIVENESS_INTERVAL_MS", "5000")),
  /** How long a TERMINATED record stays queryable before eviction. */
  terminatedRetentionMs: Number(env("GATEWAY_TERMINATED_RETENTION_MS", "300000")),
  /** Port the application listens on inside the container. */
  appPort: Number(env("WORKER_APP_PORT", "8080")),
  /** How long to wait for /health after `docker run`. */
  bootTimeoutMs: Number(env("GATEWAY_BOOT_TIMEOUT_MS", "30000")),
  /** Hook request timeout. */
  hookTimeoutMs: Number(env("GATEWAY_HOOK_TIMEOUT_MS", "5000")),
  defaultIdlePolicy: {
    autoResumeEnabled: true,
    maxIdleDurationSeconds: Number(env("GATEWAY_MAX_IDLE_SECONDS", "900")),
    suspendedDurationSeconds: Number(env("GATEWAY_SUSPENDED_SECONDS", "1800")),
  } satisfies IdlePolicy,
  defaultMaximumDurationSeconds: Number(env("GATEWAY_MAX_DURATION_SECONDS", "28800")),
} as const;
