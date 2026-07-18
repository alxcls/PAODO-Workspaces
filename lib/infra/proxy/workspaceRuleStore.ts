// Ownership of per-workspace injection rules + the auth check that gates them.
// Split out of CredentialProxy so the "which rules apply to this connection" decision — including
// the fail-closed secret verification — is a pure, socket-free unit that can be tested directly.
import { verifyProxySecret } from "./proxyCA";
import { createAuditLogger } from "../logger";
import { LogThrottle } from "../logThrottle";
import type { DomainRule } from "../security/workspaceSecretStore";

const audit = createAuditLogger("credentialProxy");

// The workspace id + secret a container presented in its Proxy-Authorization header.
export interface ProxyAuth {
  wsId: string;
  secret: string;
}

export class WorkspaceRuleStore {
  private rules = new Map<string, DomainRule[]>();
  private rejectedAuthThrottle = new LogThrottle();

  setRules(wsId: string, rules: DomainRule[]): void {
    if (rules.length === 0) {
      this.rules.delete(wsId);
      this.rejectedAuthThrottle.forget(wsId);
    } else this.rules.set(wsId, rules);
  }

  clearRules(wsId: string): void {
    this.rules.delete(wsId);
    this.rejectedAuthThrottle.forget(wsId);
  }

  // Resolve the injection rules a connection is allowed to use. A workspace's rules apply only when
  // the presented secret matches the one derived from its id. A caller that knows another
  // workspace's id but not its secret gets an empty rule set — the connection still tunnels/forwards,
  // but no real value is ever substituted (fail closed).
  resolve(auth: ProxyAuth | null): DomainRule[] {
    if (auth && verifyProxySecret(auth.wsId, auth.secret)) {
      return this.rules.get(auth.wsId) ?? [];
    }
    const wsId = auth?.wsId ?? "";
    if (this.rules.has(wsId)) {
      const decision = this.rejectedAuthThrottle.record(wsId);
      if (decision.emit) {
        audit.warn(
          {
            wsId,
            event: "proxy_auth_rejected",
            ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
          },
          "proxy secret mismatch — refusing credential injection",
        );
      }
    }
    return [];
  }
}
