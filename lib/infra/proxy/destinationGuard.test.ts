import { describe, it, expect } from "vitest";
import { isBlockedAddress, makeGuardedLookup } from "./destinationGuard";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, CGNAT, link-local/metadata and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1", // multicast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "172.15.0.1", "172.32.0.1", "192.167.1.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks loopback, ULA, link-local and IPv4-mapped-internal IPv6", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("fails closed on non-IP input", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("makeGuardedLookup", () => {
  it("returns an EBLOCKED error when the resolved address is blocked", async () => {
    const lookup = makeGuardedLookup();
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("127.0.0.1", {}, (e) => resolve(e));
    });
    expect(err?.code).toBe("EBLOCKED");
  });

  it("resolves a public IP literal without error", async () => {
    const lookup = makeGuardedLookup();
    const { err, address } = await new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
      lookup("8.8.8.8", {}, (e, addr) => resolve({ err: e, address: addr }));
    });
    expect(err).toBeNull();
    expect(address).toBe("8.8.8.8");
  });
});
