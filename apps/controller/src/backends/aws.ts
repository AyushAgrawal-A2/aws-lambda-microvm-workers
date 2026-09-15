import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";

import {
  asState,
  MicrovmNotFoundError,
  type AuthToken,
  type Backend,
  type MicrovmView,
} from "@/backend";
import { config } from "@/config";

// AWS_ENDPOINT_URL (Floci: http://localhost:4566) is honored by the SDK.
const client = new LambdaMicrovmsClient({ region: config.aws.region });

function toView(view: {
  microvmId?: string | undefined;
  state?: string | undefined;
  endpoint?: string | undefined;
  stateReason?: string | undefined;
}): MicrovmView {
  if (view.microvmId === undefined || view.endpoint === undefined) {
    throw new Error("MicroVM response is missing microvmId or endpoint");
  }
  return {
    microvmId: view.microvmId,
    state: asState(view.state),
    endpoint: view.endpoint,
    stateReason: view.stateReason ?? null,
  };
}

/** Re-throws the SDK's not-found error as our own so callers can prune. */
async function notFoundAware<Value>(operation: Promise<Value>): Promise<Value> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      throw new MicrovmNotFoundError(error.message);
    }
    throw error;
  }
}

export const awsBackend: Backend = {
  name: "aws",

  async run(clientToken, runHookPayload) {
    if (config.aws.imageIdentifier === "") {
      throw new Error("MICROVM_IMAGE_ARN is required for the aws backend");
    }
    const response = await client.send(
      new RunMicrovmCommand({
        imageIdentifier: config.aws.imageIdentifier,
        clientToken,
        runHookPayload,
        idlePolicy: config.idlePolicy,
        maximumDurationInSeconds: config.maximumDurationInSeconds,
        ingressNetworkConnectors: [config.aws.ingressConnector],
        egressNetworkConnectors: [config.aws.egressConnector],
        ...(config.aws.executionRoleArn === undefined
          ? {}
          : { executionRoleArn: config.aws.executionRoleArn }),
      }),
    );
    return toView(response);
  },

  async get(microvmId) {
    return toView(
      await notFoundAware(client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))),
    );
  },

  async createToken(microvmId, expirationInMinutes): Promise<AuthToken> {
    const response = await notFoundAware(
      client.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: microvmId,
          expirationInMinutes,
          allowedPorts: [{ allPorts: {} }],
        }),
      ),
    );
    const token = response.authToken?.["X-aws-proxy-auth"];
    if (token === undefined) {
      throw new Error("CreateMicrovmAuthToken returned no X-aws-proxy-auth token");
    }
    return { token, expiresAt: Date.now() + expirationInMinutes * 60_000 };
  },

  async terminate(microvmId) {
    await notFoundAware(client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId })));
  },

  wsUrl(endpoint, path) {
    return `wss://${endpoint}${path}`;
  },
};
