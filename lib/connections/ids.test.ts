import { describe, expect, it } from "vitest";
import { connectionKind, mintConnectionId } from "./ids";

describe("minting a connection id", () => {
  it("marks which graph the id belongs to", () => {
    expect(mintConnectionId("link")).toMatch(/^link_/);
    expect(mintConnectionId("call")).toMatch(/^call_/);
  });

  it("does not repeat itself", () => {
    const minted = new Set(Array.from({ length: 100 }, () => mintConnectionId("call")));
    expect(minted.size).toBe(100);
  });

  it("mints what it recognises", () => {
    expect(connectionKind(mintConnectionId("link"))).toBe("link");
    expect(connectionKind(mintConnectionId("call"))).toBe("call");
  });
});

describe("reading a connection id", () => {
  // The mistake the prefix exists to catch: the ids beside it in a listing are workspaces and drives.
  it("does not accept the ids a listing prints next to it", () => {
    expect(connectionKind("b6b8b4f1-0000-4000-8000-000000000000")).toBeNull();
  });

  it("does not accept a prefix with no connection after it", () => {
    expect(connectionKind("link_")).toBeNull();
  });

  it("does not accept a prefix that is not one of the two", () => {
    expect(connectionKind("edge_b6b8b4f1")).toBeNull();
    expect(connectionKind("")).toBeNull();
  });
});
