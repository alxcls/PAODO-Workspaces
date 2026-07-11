// The rule store owns the fail-closed decision that gates credential injection: a workspace's rules
// apply only when the container proved it holds that workspace's derived proxy secret. These pin
// that decision directly (verifyProxySecret is mocked so we test the store's branching, not crypto).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DomainRule } from "../security/workspaceSecretStore";

// Mock the crypto check: "correct" is the only secret that verifies, and only for the ws it belongs
// to — so we can drive matched / mismatched / unknown-workspace cases deterministically.
vi.mock("./proxyCA", () => ({
  verifyProxySecret: vi.fn((wsId: string, presented: string | undefined) => presented === `secret-${wsId}`),
}));

import { WorkspaceRuleStore } from "./workspaceRuleStore";

const rule = (domain: string): DomainRule => ({ domain, tokenMap: new Map([["__pxy_t__", "real"]]) });

describe("WorkspaceRuleStore", () => {
  let store: WorkspaceRuleStore;
  beforeEach(() => {
    store = new WorkspaceRuleStore();
  });

  describe("setRules / clearRules", () => {
    it("stores rules that a verified caller can then resolve", () => {
      store.setRules("ws1", [rule("api.openai.com")]);
      expect(store.resolve({ wsId: "ws1", secret: "secret-ws1" })).toHaveLength(1);
    });

    it("setRules with an empty array removes the workspace entirely", () => {
      store.setRules("ws1", [rule("api.openai.com")]);
      store.setRules("ws1", []);
      expect(store.resolve({ wsId: "ws1", secret: "secret-ws1" })).toEqual([]);
    });

    it("clearRules drops a workspace's rules", () => {
      store.setRules("ws1", [rule("api.openai.com")]);
      store.clearRules("ws1");
      expect(store.resolve({ wsId: "ws1", secret: "secret-ws1" })).toEqual([]);
    });
  });

  describe("resolve (fail-closed gating)", () => {
    beforeEach(() => {
      store.setRules("ws1", [rule("api.openai.com")]);
    });

    it("returns the workspace's rules when the presented secret verifies", () => {
      const rules = store.resolve({ wsId: "ws1", secret: "secret-ws1" });
      expect(rules).toHaveLength(1);
      expect(rules[0].domain).toBe("api.openai.com");
    });

    it("returns empty when the secret does NOT match (right id, wrong secret)", () => {
      // The core security property: knowing another workspace's id is not enough to get its rules.
      expect(store.resolve({ wsId: "ws1", secret: "wrong" })).toEqual([]);
    });

    it("returns empty for an unauthenticated connection (no auth header)", () => {
      expect(store.resolve(null)).toEqual([]);
    });

    it("returns empty for a workspace that has no rules, even with a valid secret", () => {
      expect(store.resolve({ wsId: "ws-unknown", secret: "secret-ws-unknown" })).toEqual([]);
    });

    it("does not leak one workspace's rules to another verified workspace", () => {
      store.setRules("ws2", [rule("api.anthropic.com")]);
      const rules = store.resolve({ wsId: "ws2", secret: "secret-ws2" });
      expect(rules).toHaveLength(1);
      expect(rules[0].domain).toBe("api.anthropic.com");
    });
  });
});
