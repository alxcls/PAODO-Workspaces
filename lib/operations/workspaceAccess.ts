// The workspace's own inbound channels: the agent API key and the MCP bearer secret. One file for both
// because they are the same capability twice over, and because the read and the write encode one shared
// invariant — an enabled channel always has a key behind it. getWorkspaceAccess relies on that when it
// shows a URL; setChannelEnabled is what makes it true.
//
// Egress does not gate these. A workspace with internetAccess off still answers on both channels, so
// nothing here carries the `blockedBy` marker that third-party secrets do (see workspaceSecrets).
import { mint, setEnabled, state, type CredentialState } from "@/lib/infra/security/credentialStore";
import { WorkspaceUpdateError } from "./workspaceErrors";

export type AccessChannel = "workspace-api" | "workspace-mcp";

export interface WorkspaceAccessDetails {
  workspaceApiAccess: boolean;
  apiEndpoint: string | null;
  workspaceMcpAccess: boolean;
  mcpConnectionUrl: string | null;
}

type CredentialStateReader = (
  channel: AccessChannel,
  workspaceId: string,
) => Pick<CredentialState, "enabled" | "hasSecret">;

/** The credential operations a channel toggle needs, in the order the toggle must perform them. */
export interface ChannelCredentials {
  /** Whether a key already exists, read before enabling so minting stays a first-time-only action. */
  hasSecret(channel: AccessChannel, id: string): boolean;
  setEnabled(channel: AccessChannel, id: string, enabled: boolean): void;
  /** Mints the channel's key and returns the plaintext once; the store keeps only a hash. */
  mint(channel: AccessChannel, id: string): string;
}

function defaultChannelCredentials(): ChannelCredentials {
  return {
    hasSecret: (channel, id) => state(channel, id).hasSecret,
    setEnabled: (channel, id, enabled) => setEnabled(channel, id, enabled),
    mint: (channel, id) => mint(channel, id),
  };
}

export function validateChannelEnabled(field: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceUpdateError(`${field} must be a boolean`);
  return value;
}

/**
 * Returns the external-access fields shown by the workspace UI without exposing either credential.
 * A URL is visible only while its channel is enabled and has a credential, matching CredentialPanel —
 * and, because setChannelEnabled guarantees a key whenever it enables one, an enabled channel with no
 * URL means its key was revoked out from under it rather than never issued.
 */
export function getWorkspaceAccess(
  id: string,
  connectionOrigin: string,
  readCredentialState: CredentialStateReader = state,
): WorkspaceAccessDetails {
  const api = readCredentialState("workspace-api", id);
  const mcp = readCredentialState("workspace-mcp", id);
  const origin = connectionOrigin.replace(/\/+$/, "");

  return {
    workspaceApiAccess: api.enabled,
    apiEndpoint: api.enabled && api.hasSecret ? `${origin}/api/workspaces/${encodeURIComponent(id)}/agent` : null,
    workspaceMcpAccess: mcp.enabled,
    mcpConnectionUrl: mcp.enabled && mcp.hasSecret ? `${origin}/api/workspaces/${encodeURIComponent(id)}/mcp` : null,
  };
}

/**
 * Opens or closes a channel. Turning one on is enough to make it usable: its key is minted when none
 * exists and never replaced when one does, so toggling off and on again keeps whatever consumers
 * already hold, while a channel whose key was revoked heals on the next enable rather than staying
 * permanently dark.
 *
 * Returns the plaintext of a key minted by this call, readable exactly once — the store keeps only a
 * hash afterwards. Returns undefined when the channel already had a key, or was switched off.
 */
export function setChannelEnabled(
  channel: AccessChannel,
  id: string,
  enabled: boolean,
  credentials: ChannelCredentials = defaultChannelCredentials(),
): string | undefined {
  // Read before enabling, so the two channels cannot drift on the order that makes minting
  // first-time-only.
  const hadSecret = credentials.hasSecret(channel, id);
  credentials.setEnabled(channel, id, enabled);
  return enabled && !hadSecret ? credentials.mint(channel, id) : undefined;
}
