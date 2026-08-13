import { beforeEach, describe, expect, it } from "vitest";
import { resetLogThrottle } from "../logThrottle";
import {
  classifyInfrastructureResourceExhaustion,
  reportInfrastructureResourceExhaustion,
} from "./infrastructureFailure";

beforeEach(() => resetLogThrottle());

describe("infrastructure resource exhaustion", () => {
  it("classifies Docker's observed default-address-pool exhaustion", () => {
    expect(
      classifyInfrastructureResourceExhaustion(
        new Error("docker network create failed: all predefined address pools have been fully subnetted"),
      ),
    ).toEqual({
      failureClass: "resource_exhaustion",
      failureCode: "DOCKER_NETWORK_POOL_EXHAUSTED",
      resource: "docker_network_address_pool",
      resourceScope: "docker_host",
      retryable: false,
    });
  });

  it("recognizes Docker's older equivalent wording but not unrelated start failures", () => {
    expect(
      classifyInfrastructureResourceExhaustion(
        "could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network",
      )?.failureCode,
    ).toBe("DOCKER_NETWORK_POOL_EXHAUSTED");
    expect(classifyInfrastructureResourceExhaustion(new Error("Cannot connect to the Docker daemon"))).toBeNull();
  });

  it("emits stable fields and reports suppressed retries on the next window", () => {
    const records: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const logger = {
      error(bindings: Record<string, unknown>, message: string) {
        records.push({ bindings, message });
      },
    };
    const error = new Error("all predefined address pools have been fully subnetted");
    const context = { workspaceId: "ws-1", stage: "ensure_network" };

    expect(reportInfrastructureResourceExhaustion(logger, error, context, 1_000)).toBe(true);
    expect(reportInfrastructureResourceExhaustion(logger, error, context, 1_001)).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      message: "Docker network address pool exhausted",
      bindings: {
        event: "infrastructure_resource_exhausted",
        outcome: "workspace_container_unavailable",
        failureCode: "DOCKER_NETWORK_POOL_EXHAUSTED",
        workspaceId: "ws-1",
        stage: "ensure_network",
        suppressed: 0,
      },
    });

    reportInfrastructureResourceExhaustion(logger, error, context, 11_000);
    expect(records).toHaveLength(2);
    expect(records[1].bindings.suppressed).toBe(1);
  });

  it("leaves unknown errors for the generic container-start log", () => {
    const records: unknown[] = [];
    const handled = reportInfrastructureResourceExhaustion(
      { error: (...args: unknown[]) => records.push(args) },
      new Error("docker run failed"),
      { workspaceId: "ws-1", stage: "run_container" },
    );
    expect(handled).toBe(false);
    expect(records).toEqual([]);
  });
});
