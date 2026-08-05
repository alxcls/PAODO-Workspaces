// The workspace's own inbound channels: the agent API key and the MCP bearer key. One file for both
// because they are the same capability twice over.
//
// A channel has two independent axes: whether it is open (here) and whether it has a credential (the
// credential routes' generate/rotate/revoke). Nothing in this file touches the second one — opening a
// channel that has no key leaves it open and keyless, which the UI shows as "Key required".
//
// Egress does not gate these. A workspace with internetAccess off still answers on both channels, so
// nothing here carries the `blockedBy` marker that third-party secrets do (see workspaceSecrets).
import { setEnabled, state, type CredentialState } from "@/lib/infra/security/credentialStore";
import { WorkspaceUpdateError } from "./errors";

export type AccessChannel = "workspace-api" | "workspace-mcp";

/**
 * Each channel reports its two axes separately, then its address. A caller that wants to know why a
 * channel is unusable — closed, or open with no key — can read it here; that is not something one
 * nullable URL can express, and the CLI has no panel to infer it from.
 */
export interface WorkspaceAccessDetails {
  workspaceApiAccess: boolean;
  workspaceApiHasKey: boolean;
  apiEndpoint: string;
  workspaceMcpAccess: boolean;
  workspaceMcpHasKey: boolean;
  mcpConnectionUrl: string;
}

type CredentialStateReader = (
  channel: AccessChannel,
  workspaceId: string,
) => Pick<CredentialState, "enabled" | "hasKey">;

/** The one credential operation a channel toggle needs. It never reads or writes the key itself. */
export interface ChannelCredentials {
  setEnabled(channel: AccessChannel, id: string, enabled: boolean): void;
}

// Deliberately a factory that forwards, not `{ setEnabled }` captured at module load: the direct
// binding resolves the import at init, which a partial test mock of credentialStore cannot replace.
function defaultChannelCredentials(): ChannelCredentials {
  return {
    setEnabled: (channel, id, enabled) => setEnabled(channel, id, enabled),
  };
}

export function validateChannelEnabled(field: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceUpdateError(`${field} must be a boolean`);
  return value;
}

/**
 * Returns the external-access fields for a workspace without exposing either credential.
 *
 * Reports both axes per channel and the address unconditionally. The address is a property of where
 * the workspace lives, not of whether a call would currently succeed, so folding the two axes into a
 * nullable URL only destroyed information: one `null` meant closed, or open-and-keyless, and the
 * caller could not tell which, nor which of the two things to go and fix. The booleans say that
 * plainly, and a URL that is present but not yet usable is exactly what an operator needs while
 * setting an integration up — it is the value they have to paste somewhere before it works.
 */
export function getWorkspaceAccess(
  id: string,
  connectionOrigin: string,
  readCredentialState: CredentialStateReader = state,
): WorkspaceAccessDetails {
  const api = readCredentialState("workspace-api", id);
  const mcp = readCredentialState("workspace-mcp", id);
  const origin = connectionOrigin.replace(/\/+$/, "");
  const workspace = encodeURIComponent(id);

  return {
    workspaceApiAccess: api.enabled,
    workspaceApiHasKey: api.hasKey,
    apiEndpoint: `${origin}/api/workspaces/${workspace}/agent`,
    workspaceMcpAccess: mcp.enabled,
    workspaceMcpHasKey: mcp.hasKey,
    mcpConnectionUrl: `${origin}/api/workspaces/${workspace}/mcp`,
  };
}

/**
 * Opens or closes a channel, and does nothing else.
 *
 * It deliberately does not mint. A first key comes from an explicit generate, so the plaintext — which
 * is readable exactly once — is only ever produced by a caller that asked for it and is reading the
 * response. Toggling therefore stays non-destructive in both directions: consumers keep whatever key
 * they hold across an off/on cycle, and a caller that flips this flag can never lose a key it never
 * requested.
 */
export function setChannelEnabled(
  channel: AccessChannel,
  id: string,
  enabled: boolean,
  credentials: ChannelCredentials = defaultChannelCredentials(),
): void {
  credentials.setEnabled(channel, id, enabled);
}
