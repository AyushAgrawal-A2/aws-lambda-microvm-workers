import { randomUUID } from "node:crypto";

import { config, type IdlePolicy } from "@/config";
import {
  containerStatus,
  containerStatuses,
  pauseContainer,
  removeContainer,
  startContainer,
  unpauseContainer,
  type Container,
} from "@/docker";
import { postHook, waitForReady } from "@/hooks";
import { pruneExpiredTokens, revokeTokens } from "@/tokens";

export const CONTAINER_LABEL = "microvm-gateway";
/** Label value: containers belong to the gateway instance on this port. */
export const CONTAINER_OWNER = String(config.port);

/**
 * Everything that touches Docker or the worker, gathered so tests can swap in
 * fakes with `Object.assign(runtime, ...)` and drive the state machine without
 * containers.
 */
export const runtime = {
  startContainer,
  pauseContainer,
  unpauseContainer,
  removeContainer,
  containerStatus,
  containerStatuses,
  waitForReady,
  postHook,
};

/** Thrown when the MicroVM cap is reached; the API maps it to 402 like AWS. */
export class QuotaExceededError extends Error {
  override readonly name = "ServiceQuotaExceededException";
}

export type MicrovmState =
  "PENDING" | "RUNNING" | "SUSPENDING" | "SUSPENDED" | "TERMINATING" | "TERMINATED";

export type Microvm = {
  microvmId: string;
  image: string;
  container: Container | null;
  state: MicrovmState;
  stateReason: string | null;
  idlePolicy: IdlePolicy;
  maximumDurationSeconds: number;
  runHookPayload: string;
  startedAt: number;
  lastTrafficAt: number;
  suspendedAt: number | null;
  terminatedAt: number | null;
  /** Serializes lifecycle transitions per VM. */
  lock: Promise<void>;
};

export type RunOptions = {
  idlePolicy?: Partial<IdlePolicy>;
  maximumDurationInSeconds?: number;
  runHookPayload?: string;
  clientToken?: string;
};

const swallow = (): void => {
  // intentionally ignored
};

const microvms = new Map<string, Microvm>();
const byClientToken = new Map<string, string>();

export function listMicrovms(): Microvm[] {
  return [...microvms.values()];
}

export function getMicrovm(microvmId: string): Microvm | undefined {
  return microvms.get(microvmId);
}

/** Public view, shaped like the RunMicrovm / GetMicrovm responses. */
export function describe(microvm: Microvm) {
  return {
    microvmId: microvm.microvmId,
    state: microvm.state,
    stateReason: microvm.stateReason,
    endpoint: `${config.publicHost}:${config.port}/mvm/${microvm.microvmId}`,
    idlePolicy: microvm.idlePolicy,
    maximumDurationInSeconds: microvm.maximumDurationSeconds,
    startedAt: microvm.startedAt,
    terminatedAt: microvm.terminatedAt,
    image: microvm.image,
  };
}

function transition(microvm: Microvm, state: MicrovmState, reason: string | null = null): void {
  console.log(
    `[${microvm.microvmId}] ${microvm.state} -> ${state}${reason === null ? "" : ` (${reason})`}`,
  );
  microvm.state = state;
  microvm.stateReason = reason;
}

function withLock(microvm: Microvm, operation: () => Promise<void>): Promise<void> {
  const next = microvm.lock.then(operation, operation);
  microvm.lock = next.catch(swallow);
  return next;
}

function liveCount(): number {
  let count = 0;
  for (const microvm of microvms.values()) {
    if (microvm.state !== "TERMINATED") {
      count += 1;
    }
  }
  return count;
}

export function runMicrovm(options: RunOptions): Microvm {
  if (options.clientToken !== undefined) {
    const existingId = byClientToken.get(options.clientToken);
    const existing = existingId === undefined ? undefined : microvms.get(existingId);
    if (existing !== undefined && existing.state !== "TERMINATED") {
      return existing;
    }
  }
  if (liveCount() >= config.maxMicrovms) {
    throw new QuotaExceededError(
      `MicroVM quota of ${config.maxMicrovms} reached; terminate one or raise GATEWAY_MAX_MICROVMS`,
    );
  }

  const now = Date.now();
  const microvm: Microvm = {
    microvmId: `mvm-${randomUUID()}`,
    image: config.image,
    container: null,
    state: "PENDING",
    stateReason: null,
    idlePolicy: { ...config.defaultIdlePolicy, ...options.idlePolicy },
    maximumDurationSeconds:
      options.maximumDurationInSeconds ?? config.defaultMaximumDurationSeconds,
    runHookPayload: options.runHookPayload ?? "",
    startedAt: now,
    lastTrafficAt: now,
    suspendedAt: null,
    terminatedAt: null,
    lock: Promise.resolve(),
  };
  microvms.set(microvm.microvmId, microvm);
  if (options.clientToken !== undefined) {
    byClientToken.set(options.clientToken, microvm.microvmId);
  }
  guard(
    withLock(microvm, () => provision(microvm)),
    microvm,
    "provision",
  );
  return microvm;
}

/**
 * Every fire-and-forget lifecycle call goes through here so a rejected docker
 * command never becomes an unhandled rejection that kills the gateway. Each
 * operation is responsible for leaving the VM in a sane state; a container
 * that actually died is picked up by the liveness reaper.
 */
export function guard(promise: Promise<void>, microvm: Microvm, what: string): void {
  promise.catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[${microvm.microvmId}] ${what} failed: ${reason}`);
  });
}

async function provision(microvm: Microvm): Promise<void> {
  try {
    microvm.container = await runtime.startContainer(
      microvm.microvmId,
      microvm.image,
      config.appPort,
      { [CONTAINER_LABEL]: CONTAINER_OWNER },
      config.limits,
    );
    const { containerId, hostPort } = microvm.container;
    await runtime.waitForReady(hostPort, config.bootTimeoutMs, async () => {
      const status = await runtime.containerStatus(containerId);
      return status === "running" || status === "paused";
    });
    if (!(await runtime.postHook(microvm.container.hostPort, "validate"))) {
      throw new Error("/validate hook failed");
    }
    const runHookAccepted = await runtime.postHook(microvm.container.hostPort, "run", {
      microvmId: microvm.microvmId,
      runHookPayload: microvm.runHookPayload,
    });
    if (!runHookAccepted) {
      throw new Error("/run hook failed");
    }
    microvm.lastTrafficAt = Date.now();
    transition(microvm, "RUNNING");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await destroy(microvm, `provisioning failed: ${reason}`);
  }
}

/**
 * Suspends a RUNNING VM. A failed pause is not fatal: the VM goes back to
 * RUNNING with the reason recorded, and the idle policy will try again later.
 */
export function suspendMicrovm(microvm: Microvm): Promise<void> {
  return withLock(microvm, async () => {
    if (microvm.state !== "RUNNING" || microvm.container === null) {
      return;
    }
    transition(microvm, "SUSPENDING");
    await runtime.postHook(microvm.container.hostPort, "suspend");
    try {
      await runtime.pauseContainer(microvm.container.containerId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A timed-out CLI may still have applied the pause; trust Docker, not the error.
      const actual = await runtime.containerStatus(microvm.container.containerId);
      if (actual === "paused") {
        microvm.suspendedAt = Date.now();
        transition(microvm, "SUSPENDED", `pause reported failure but applied: ${reason}`);
        return;
      }
      microvm.lastTrafficAt = Date.now();
      transition(microvm, "RUNNING", `suspend failed: ${reason}`);
      // The worker already closed its clients; let it accept them again.
      await runtime.postHook(microvm.container.hostPort, "resume");
      return;
    }
    microvm.suspendedAt = Date.now();
    transition(microvm, "SUSPENDED");
  });
}

/** Resumes a SUSPENDED VM. A failed unpause leaves it SUSPENDED for the reaper. */
export function resumeMicrovm(microvm: Microvm): Promise<void> {
  return withLock(microvm, async () => {
    if (microvm.state !== "SUSPENDED" || microvm.container === null) {
      return;
    }
    await runtime.unpauseContainer(microvm.container.containerId);
    await runtime.postHook(microvm.container.hostPort, "resume");
    microvm.suspendedAt = null;
    microvm.lastTrafficAt = Date.now();
    transition(microvm, "RUNNING");
  });
}

export function terminateMicrovm(microvm: Microvm, reason = "terminate-microvm"): Promise<void> {
  return withLock(microvm, async () => {
    if (microvm.state === "TERMINATED" || microvm.state === "TERMINATING") {
      return;
    }
    const wasSuspended = microvm.state === "SUSPENDED";
    transition(microvm, "TERMINATING", reason);
    if (microvm.container !== null) {
      if (wasSuspended) {
        await runtime.unpauseContainer(microvm.container.containerId).catch(swallow);
      }
      await runtime.postHook(microvm.container.hostPort, "terminate");
    }
    await destroy(microvm, reason);
  });
}

/** Final teardown; safe to call more than once. */
async function destroy(microvm: Microvm, reason: string): Promise<void> {
  if (microvm.state === "TERMINATED") {
    return;
  }
  if (microvm.container !== null) {
    await runtime.removeContainer(microvm.container.containerId);
    microvm.container = null;
  }
  revokeTokens(microvm.microvmId);
  microvm.terminatedAt = Date.now();
  transition(microvm, "TERMINATED", reason);
}

/** Records endpoint traffic, which is what keeps a VM from idling. */
export function touch(microvm: Microvm): void {
  microvm.lastTrafficAt = Date.now();
}

/**
 * Makes sure the VM can take traffic, auto-resuming if the idle policy allows.
 * Resolves to the container to forward to, or null when the VM is unavailable.
 */
export async function ensureRunning(microvm: Microvm): Promise<Container | null> {
  if (microvm.state === "SUSPENDING" || microvm.state === "PENDING") {
    // Wait for the in-flight transition to settle before deciding.
    await microvm.lock;
  }
  if (microvm.state === "SUSPENDED" && microvm.idlePolicy.autoResumeEnabled) {
    await resumeMicrovm(microvm);
  }
  return microvm.state === "RUNNING" ? microvm.container : null;
}

let lastLivenessCheck = 0;

/** Test hook: make the next sweep run the liveness check. */
export function resetLivenessClock(): void {
  lastLivenessCheck = 0;
}

/** Idle and duration policy enforcement, called on a timer. */
export function sweep(): void {
  const now = Date.now();
  if (now - lastLivenessCheck >= config.livenessIntervalMs) {
    lastLivenessCheck = now;
    pruneExpiredTokens();
    reapDead().catch((error: unknown) => {
      console.error("liveness check failed:", error);
    });
  }
  for (const microvm of microvms.values()) {
    if (microvm.state === "TERMINATED") {
      if (
        microvm.terminatedAt !== null &&
        now - microvm.terminatedAt > config.terminatedRetentionMs
      ) {
        evict(microvm);
      }
      continue;
    }
    const ageSeconds = (now - microvm.startedAt) / 1000;
    if (
      (microvm.state === "RUNNING" || microvm.state === "SUSPENDED") &&
      ageSeconds > microvm.maximumDurationSeconds
    ) {
      guard(terminateMicrovm(microvm, "maximumDurationInSeconds exceeded"), microvm, "terminate");
      continue;
    }
    if (microvm.state === "RUNNING") {
      const idleSeconds = (now - microvm.lastTrafficAt) / 1000;
      if (idleSeconds > microvm.idlePolicy.maxIdleDurationSeconds) {
        guard(suspendMicrovm(microvm), microvm, "suspend");
      }
    } else if (microvm.state === "SUSPENDED" && microvm.suspendedAt !== null) {
      const suspendedSeconds = (now - microvm.suspendedAt) / 1000;
      if (suspendedSeconds > microvm.idlePolicy.suspendedDurationSeconds) {
        guard(terminateMicrovm(microvm, "suspendedDurationSeconds exceeded"), microvm, "terminate");
      }
    }
  }
}

/** Drops a terminated record and its idempotency mapping. */
function evict(microvm: Microvm): void {
  microvms.delete(microvm.microvmId);
  for (const [clientToken, microvmId] of byClientToken) {
    if (microvmId === microvm.microvmId) {
      byClientToken.delete(clientToken);
    }
  }
}

/**
 * One docker call for every owned container; a worker that exited on its own
 * is torn down instead of lingering as RUNNING.
 */
async function reapDead(): Promise<void> {
  const statuses = await runtime.containerStatuses(CONTAINER_LABEL, CONTAINER_OWNER);
  for (const microvm of microvms.values()) {
    if (microvm.container === null || microvm.state === "TERMINATING") {
      continue;
    }
    const status = statuses.get(microvm.container.containerId) ?? "missing";
    if (status === "running" || status === "paused") {
      continue;
    }
    guard(
      withLock(microvm, () => destroy(microvm, `container ${status}`)),
      microvm,
      "reap",
    );
  }
}

export async function terminateAll(reason: string): Promise<void> {
  await Promise.all([...microvms.values()].map((microvm) => terminateMicrovm(microvm, reason)));
}

/** Test hook: forget every record without touching containers. */
export function resetRegistry(): void {
  microvms.clear();
  byClientToken.clear();
  lastLivenessCheck = 0;
}
