import { throttleLog } from "../logThrottle";

export type InfrastructureResourceExhaustion = {
  failureClass: "resource_exhaustion";
  failureCode: "DOCKER_NETWORK_POOL_EXHAUSTED";
  resource: "docker_network_address_pool";
  resourceScope: "docker_host";
  retryable: false;
};

export const DOCKER_NETWORK_POOL_EXHAUSTED_CODE = "DOCKER_NETWORK_POOL_EXHAUSTED" as const;
export const INFRASTRUCTURE_UNAVAILABLE_CODE = "INFRASTRUCTURE_UNAVAILABLE" as const;
const FAILURE_MARKER = `[${DOCKER_NETWORK_POOL_EXHAUSTED_CODE}]`;
export const DOCKER_NETWORK_POOL_EXHAUSTED_MESSAGE =
  "Workspace tools are unavailable because this PAODO instance has exhausted its Docker network capacity. " +
  "Stop retrying and try again after an operator increases host networking capacity.";

/** Stable cross-layer error: tool wrappers may stringify it, so its marker must survive as text. */
export class DockerNetworkPoolExhaustedError extends Error {
  readonly code = DOCKER_NETWORK_POOL_EXHAUSTED_CODE;
  readonly retryable = false;

  constructor(cause?: unknown) {
    super(`${FAILURE_MARKER} ${DOCKER_NETWORK_POOL_EXHAUSTED_MESSAGE}`, { cause });
    this.name = "DockerNetworkPoolExhaustedError";
  }
}

type ErrorLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

const DOCKER_NETWORK_POOL_PATTERNS = [
  /all predefined address pools have been fully subnetted/i,
  /could not find an available, non-overlapping IPv4 address pool among the defaults/i,
];

/** Turn stable infrastructure error signatures into fields operators can alert on. */
export function classifyInfrastructureResourceExhaustion(error: unknown): InfrastructureResourceExhaustion | null {
  if (error instanceof DockerNetworkPoolExhaustedError) {
    return {
      failureClass: "resource_exhaustion",
      failureCode: DOCKER_NETWORK_POOL_EXHAUSTED_CODE,
      resource: "docker_network_address_pool",
      resourceScope: "docker_host",
      retryable: false,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!DOCKER_NETWORK_POOL_PATTERNS.some((pattern) => pattern.test(message))) return null;
  return {
    failureClass: "resource_exhaustion",
    failureCode: "DOCKER_NETWORK_POOL_EXHAUSTED",
    resource: "docker_network_address_pool",
    resourceScope: "docker_host",
    retryable: false,
  };
}

/** Wrap Docker's unstable wording once, preserving a stable code through agent tool catches. */
export function asDockerNetworkPoolExhaustedError(error: unknown): DockerNetworkPoolExhaustedError | null {
  if (error instanceof DockerNetworkPoolExhaustedError) return error;
  return classifyInfrastructureResourceExhaustion(error) ? new DockerNetworkPoolExhaustedError(error) : null;
}

/** Recover the terminal failure after a tool has converted a thrown error into result text. */
export function infrastructureFailureFromToolResult(
  result: string,
): { code: typeof INFRASTRUCTURE_UNAVAILABLE_CODE; message: string } | null {
  if (!result.includes(FAILURE_MARKER)) return null;
  return { code: INFRASTRUCTURE_UNAVAILABLE_CODE, message: DOCKER_NETWORK_POOL_EXHAUSTED_MESSAGE };
}

/**
 * Emit one queryable critical record for a recognized exhaustion failure.
 *
 * A blocked agent can retry tools hundreds of times. Collapse identical host-wide failures into
 * one record per window so they remain visible without rotating the surrounding evidence away.
 * Returns true whenever the error was recognized, including when this occurrence was suppressed.
 */
export function reportInfrastructureResourceExhaustion(
  logger: ErrorLogger,
  error: unknown,
  context: { workspaceId: string; stage: string },
  now = Date.now(),
): boolean {
  const failure = classifyInfrastructureResourceExhaustion(error);
  if (!failure) return false;

  const suppressed = throttleLog(`infrastructure_resource_exhausted:${failure.failureCode}`, now);
  if (suppressed !== null) {
    logger.error(
      {
        event: "infrastructure_resource_exhausted",
        outcome: "workspace_container_unavailable",
        err: error,
        ...context,
        ...failure,
        suppressed,
      },
      "Docker network address pool exhausted",
    );
  }
  return true;
}
