import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A wedged docker CLI must not hold a MicroVM lock forever. */
const DOCKER_TIMEOUT_MS = 30_000;

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, {
    maxBuffer: 1024 * 1024,
    timeout: DOCKER_TIMEOUT_MS,
  });
  return stdout.trim();
}

export type Container = { containerId: string; hostPort: number };

/** Starts a container with the app port published on a random loopback port. */
export type Limits = { memory: string; cpus: string; pids: number };

export async function startContainer(
  name: string,
  image: string,
  appPort: number,
  labels: Record<string, string>,
  limits: Limits,
): Promise<Container> {
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  const containerId = await docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1::${appPort}`,
    "--memory",
    limits.memory,
    "--cpus",
    limits.cpus,
    "--pids-limit",
    String(limits.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp",
    ...labelArgs,
    image,
  ]);
  const mapping = await docker([
    "inspect",
    "-f",
    `{{(index (index .NetworkSettings.Ports "${appPort}/tcp") 0).HostPort}}`,
    containerId,
  ]);
  const hostPort = Number(mapping);
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    await removeContainer(containerId);
    throw new Error(`could not determine host port for container ${containerId}`);
  }
  return { containerId, hostPort };
}

export type ContainerStatus = "running" | "paused" | "exited" | "missing";

function asStatus(raw: string): ContainerStatus {
  // `restarting` only appears with a restart policy, but if one is ever added
  // a restarting worker is alive, not something to reap.
  if (raw === "running" || raw === "restarting") {
    return "running";
  }
  return raw === "paused" ? "paused" : "exited";
}

/** Current status of one container; `missing` when Docker no longer knows it. */
export async function containerStatus(containerId: string): Promise<ContainerStatus> {
  try {
    return asStatus(await docker(["inspect", "-f", "{{.State.Status}}", containerId]));
  } catch {
    return "missing";
  }
}

/** Statuses of every container this gateway instance owns, in one docker call. */
export async function containerStatuses(
  label: string,
  value: string,
): Promise<Map<string, ContainerStatus>> {
  const out = await docker([
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    `label=${label}=${value}`,
    "--format",
    "{{.ID}}\t{{.State}}",
  ]);
  const statuses = new Map<string, ContainerStatus>();
  for (const line of out.split("\n")) {
    const [containerId, state] = line.split("\t");
    if (containerId !== undefined && containerId !== "" && state !== undefined) {
      statuses.set(containerId, asStatus(state));
    }
  }
  return statuses;
}

export async function pauseContainer(containerId: string): Promise<void> {
  await docker(["pause", containerId]);
}

export async function unpauseContainer(containerId: string): Promise<void> {
  await docker(["unpause", containerId]);
}

export async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker(["rm", "-f", containerId]);
  } catch (error) {
    console.warn(
      `docker rm ${containerId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Removes containers left behind by a previous gateway process on the same port. */
export async function removeStaleContainers(label: string, value: string): Promise<number> {
  const out = await docker(["ps", "-aq", "--filter", `label=${label}=${value}`]);
  const containerIds = out.split("\n").filter((line) => line !== "");
  await Promise.all(containerIds.map((containerId) => removeContainer(containerId)));
  return containerIds.length;
}
