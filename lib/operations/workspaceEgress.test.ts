import { describe, expect, it } from "vitest";
import { setInternetAccess, validateInternetAccess, type EgressServices, type EgressWriter } from "./workspaceEgress";

const writer = (overrides: Partial<EgressWriter> = {}): EgressWriter => ({
  setWorkspaceInternetAccess: () => true,
  ...overrides,
});

const services = (overrides: Partial<EgressServices> = {}): EgressServices => ({
  setPolicy: () => {},
  stopContainer: async () => {},
  ...overrides,
});

describe("setting workspace egress", () => {
  it("persists the setting, enforces it at the proxy, and tears down the container", async () => {
    const steps: string[] = [];
    const result = await setInternetAccess(
      "ws-1",
      true,
      false,
      writer({
        setWorkspaceInternetAccess: (_id, enabled) => {
          steps.push(`registry:${enabled}`);
          return true;
        },
      }),
      services({
        setPolicy: (_id, enabled) => steps.push(`policy:${enabled}`),
        stopContainer: async () => {
          steps.push("stop");
        },
      }),
    );

    expect(steps).toEqual(["registry:true", "policy:true", "stop"]);
    expect(result).toEqual({ applied: true, warnings: [] });
  });

  // The registry and the proxy policy are one security boundary: a workspace recorded as offline while
  // the proxy still lets it out is worse than a failed request, so the registry write is undone.
  it("rolls the registry back and raises when the proxy rejects the change", async () => {
    const written: boolean[] = [];
    const store = writer({
      setWorkspaceInternetAccess: (_id, enabled) => {
        written.push(enabled);
        return true;
      },
    });

    await expect(
      setInternetAccess(
        "ws-1",
        true,
        false,
        store,
        services({
          setPolicy: () => {
            throw new Error("proxy unavailable");
          },
        }),
      ),
    ).rejects.toThrow("failed to persist internet-access policy");

    expect(written).toEqual([true, false]);
  });

  it("never stops the container when the proxy rejected the change", async () => {
    await expect(
      setInternetAccess(
        "ws-1",
        false,
        true,
        writer(),
        services({
          setPolicy: () => {
            throw new Error("proxy unavailable");
          },
          stopContainer: async () => {
            throw new Error("must not stop a container after a rolled-back toggle");
          },
        }),
      ),
    ).rejects.toThrow("failed to persist internet-access policy");
  });

  // The setting is persisted and the proxy is already enforcing it; only the network-layer teardown is
  // pending. That is a warning, not a failure — reporting it as one would invite a pointless retry.
  it("warns rather than fails when the container cannot be stopped", async () => {
    const result = await setInternetAccess(
      "ws-1",
      false,
      true,
      writer(),
      services({
        stopContainer: async () => {
          throw new Error("docker daemon unavailable");
        },
      }),
    );

    expect(result.applied).toBe(true);
    expect(result.warnings).toEqual(["setting saved but the running container could not be stopped immediately"]);
  });

  // A refusal from a store that only refuses unknown ids means the workspace disappeared. Reporting it
  // as not-applied lets the caller say so; touching the proxy for a workspace that no longer exists
  // would leave a policy entry nothing owns.
  it("reports not-applied without touching the proxy when the registry refuses", async () => {
    const result = await setInternetAccess(
      "ws-1",
      true,
      false,
      writer({ setWorkspaceInternetAccess: () => false }),
      services({
        setPolicy: () => {
          throw new Error("must not set a policy for a workspace the registry refused");
        },
      }),
    );

    expect(result).toEqual({ applied: false, warnings: [] });
  });
});

describe("egress input validation", () => {
  it("rejects a non-boolean and names the field", () => {
    expect(() => validateInternetAccess("true")).toThrow("internetAccess must be a boolean");
    expect(() => validateInternetAccess(1)).toThrow("internetAccess must be a boolean");
  });

  it("returns the boolean it accepted", () => {
    expect(validateInternetAccess(true)).toBe(true);
  });
});
