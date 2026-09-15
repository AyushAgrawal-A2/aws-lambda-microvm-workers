import {
  asState,
  MicrovmNotFoundError,
  type AuthToken,
  type Backend,
  type MicrovmView,
} from "@/backend";
import { config } from "@/config";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function call(path: string, method = "GET", body?: unknown): Promise<Json> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${config.local.gatewayUrl}${path}`, init);
  if (response.status === 404) {
    throw new MicrovmNotFoundError(`gateway ${method} ${path} -> 404`);
  }
  if (!response.ok) {
    throw new Error(`gateway ${method} ${path} -> ${response.status}`);
  }
  const parsed: unknown = await response.json();
  return isRecord(parsed) ? parsed : {};
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`gateway response is missing "${field}"`);
  }
  return value;
}

function toView(view: Json): MicrovmView {
  const reason = view["stateReason"];
  return {
    microvmId: str(view["microvmId"], "microvmId"),
    state: asState(str(view["state"], "state")),
    endpoint: str(view["endpoint"], "endpoint"),
    stateReason: typeof reason === "string" ? reason : null,
  };
}

export const localBackend: Backend = {
  name: "local",

  async run(clientToken, runHookPayload) {
    const body = {
      clientToken,
      runHookPayload,
      idlePolicy: config.idlePolicy,
      maximumDurationInSeconds: config.maximumDurationInSeconds,
    };
    return toView(await call("/microvms", "POST", body));
  },

  async get(microvmId) {
    return toView(await call(`/microvms/${microvmId}`));
  },

  async createToken(microvmId, expirationInMinutes): Promise<AuthToken> {
    const result = await call(`/microvms/${microvmId}/auth-token`, "POST", {
      expirationInMinutes,
      allowedPorts: [{ allPorts: {} }],
    });
    const authToken = result["authToken"];
    const token = isRecord(authToken) ? authToken["X-aws-proxy-auth"] : undefined;
    const expiresAt = result["expiresAt"];
    if (typeof token !== "string" || typeof expiresAt !== "number") {
      throw new TypeError("gateway returned no X-aws-proxy-auth token");
    }
    return { token, expiresAt };
  },

  async terminate(microvmId) {
    await call(`/microvms/${microvmId}`, "DELETE");
  },

  wsUrl(endpoint, path) {
    return `ws://${endpoint}${path}`;
  },
};
