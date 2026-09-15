import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "@/config";
import type { Container, ContainerStatus } from "@/docker";
import type { Hook } from "@/hooks";
import {
  ensureRunning,
  getMicrovm,
  QuotaExceededError,
  resetLivenessClock,
  resetRegistry,
  resumeMicrovm,
  runMicrovm,
  runtime,
  suspendMicrovm,
  sweep,
  terminateMicrovm,
  type Microvm,
} from "@/registry";

type Calls = { hooks: Hook[]; docker: string[] };

/** Swaps every runtime function for a fake and records what was called. */
function fakeRuntime(overrides: Partial<typeof runtime> = {}): Calls {
  const calls: Calls = { hooks: [], docker: [] };
  const statuses = new Map<string, ContainerStatus>();
  const fakes: typeof runtime = {
    async startContainer(name): Promise<Container> {
      calls.docker.push(`start ${name}`);
      statuses.set(`container-${name}`, "running");
      return { containerId: `container-${name}`, hostPort: 40_000 };
    },
    async waitForReady() {
      calls.docker.push("ready");
    },
    async postHook(_hostPort, hook) {
      calls.hooks.push(hook);
      return true;
    },
    async pauseContainer(containerId) {
      calls.docker.push("pause");
      statuses.set(containerId, "paused");
    },
    async unpauseContainer(containerId) {
      calls.docker.push("unpause");
      statuses.set(containerId, "running");
    },
    async removeContainer(containerId) {
      calls.docker.push("rm");
      statuses.delete(containerId);
    },
    async containerStatus(containerId) {
      return statuses.get(containerId) ?? "missing";
    },
    async containerStatuses() {
      return new Map(statuses);
    },
  };
  Object.assign(runtime, fakes, overrides);
  return calls;
}

async function settled(microvm: Microvm): Promise<void> {
  await microvm.lock;
  await sleep(0);
}

describe("registry", () => {
  beforeEach(() => {
    resetRegistry();
  });

  it("provisions through health, ready, validate, and run before RUNNING", async () => {
    const calls = fakeRuntime();
    const microvm = runMicrovm({});
    assert.equal(microvm.state, "PENDING");
    await settled(microvm);
    assert.equal(microvm.state, "RUNNING");
    assert.deepEqual(calls.hooks, ["validate", "run"]);
    assert.deepEqual(calls.docker, [`start ${microvm.microvmId}`, "ready"]);
  });

  it("is idempotent per client token and enforces the quota", async () => {
    fakeRuntime();
    const first = runMicrovm({ clientToken: "session-1" });
    const again = runMicrovm({ clientToken: "session-1" });
    assert.equal(again, first);
    for (let count = 1; count < config.maxMicrovms; count += 1) {
      runMicrovm({});
    }
    assert.throws(() => runMicrovm({}), QuotaExceededError);
  });

  it("suspends via the hook then pause, and auto-resumes on ensureRunning", async () => {
    const calls = fakeRuntime();
    const microvm = runMicrovm({});
    await settled(microvm);
    await suspendMicrovm(microvm);
    assert.equal(microvm.state, "SUSPENDED");
    assert.deepEqual(calls.hooks.slice(-1), ["suspend"]);
    assert.deepEqual(calls.docker.slice(-1), ["pause"]);
    const container = await ensureRunning(microvm);
    assert.equal(microvm.state, "RUNNING");
    assert.notEqual(container, null);
    assert.deepEqual(calls.hooks.slice(-1), ["resume"]);
  });

  it("trusts docker over the CLI when a pause reports failure but applied", async () => {
    let paused = false;
    fakeRuntime({
      async pauseContainer() {
        paused = true;
        throw new Error("timed out");
      },
      async containerStatus() {
        return paused ? "paused" : "running";
      },
    });
    const microvm = runMicrovm({});
    await settled(microvm);
    await suspendMicrovm(microvm);
    assert.equal(microvm.state, "SUSPENDED");
    assert.match(microvm.stateReason ?? "", /applied/u);
  });

  it("returns to RUNNING when pause fails instead of dying", async () => {
    const calls = fakeRuntime({
      async pauseContainer() {
        throw new Error("docker daemon hiccup");
      },
    });
    const microvm = runMicrovm({});
    await settled(microvm);
    await suspendMicrovm(microvm);
    assert.equal(microvm.state, "RUNNING");
    assert.match(microvm.stateReason ?? "", /suspend failed/u);
    assert.deepEqual(calls.hooks.slice(-2), ["suspend", "resume"]);
  });

  it("idle policy suspends and suspended duration terminates via sweep", async () => {
    const calls = fakeRuntime();
    const microvm = runMicrovm({
      idlePolicy: { maxIdleDurationSeconds: 1, suspendedDurationSeconds: 1 },
    });
    await settled(microvm);
    microvm.lastTrafficAt = Date.now() - 5000;
    sweep();
    await settled(microvm);
    assert.equal(microvm.state, "SUSPENDED");
    microvm.suspendedAt = Date.now() - 5000;
    sweep();
    await settled(microvm);
    assert.equal(microvm.state, "TERMINATED");
    assert.match(microvm.stateReason ?? "", /suspendedDurationSeconds/u);
    assert.deepEqual(calls.docker.slice(-3), ["pause", "unpause", "rm"]);
    assert.deepEqual(calls.hooks.slice(-1), ["terminate"]);
  });

  it("reaps a container that died and terminate stays idempotent", async () => {
    let dead = false;
    const calls = fakeRuntime({
      async containerStatuses() {
        return new Map(dead ? [] : [["container-any", "running"]]);
      },
    });
    const microvm = runMicrovm({});
    await settled(microvm);
    dead = true;
    resetLivenessClock();
    sweep();
    await sleep(0);
    await settled(microvm);
    assert.equal(microvm.state, "TERMINATED");
    assert.equal(microvm.stateReason, "container missing");
    const removals = calls.docker.filter((call) => call === "rm").length;
    await terminateMicrovm(microvm);
    assert.equal(calls.docker.filter((call) => call === "rm").length, removals);
    assert.equal(microvm.stateReason, "container missing", "reason is not overwritten");
  });

  it("gives up on a container that exits during boot instead of waiting out the timeout", async () => {
    const { waitForReady } = await import("@/hooks");
    fakeRuntime({
      waitForReady: (hostPort, timeoutMs, stillAlive) =>
        waitForReady(hostPort, timeoutMs, stillAlive),
      async containerStatus() {
        return "exited";
      },
    });
    const microvm = runMicrovm({});
    const started = Date.now();
    await settled(microvm);
    assert.equal(microvm.state, "TERMINATED");
    assert.match(microvm.stateReason ?? "", /exited before becoming healthy/u);
    assert.ok(Date.now() - started < 2000, "did not wait for the boot timeout");
  });

  it("tears down when provisioning fails and records why", async () => {
    fakeRuntime({
      async waitForReady() {
        throw new Error("never healthy");
      },
    });
    const microvm = runMicrovm({});
    await settled(microvm);
    assert.equal(microvm.state, "TERMINATED");
    assert.match(microvm.stateReason ?? "", /never healthy/u);
    assert.equal(getMicrovm(microvm.microvmId)?.container, null);
    assert.equal(await ensureRunning(microvm), null);
    await resumeMicrovm(microvm);
    assert.equal(microvm.state, "TERMINATED");
  });
});
