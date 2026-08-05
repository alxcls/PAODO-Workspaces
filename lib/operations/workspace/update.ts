// The unified workspace update contract: one entry point every trigger writes through — the settings
// UI, the per-setting REST routes, the CLI, MCP adapters — so the rules and their messages exist once
// instead of once per transport.
//
// This file owns the contract and nothing else. Each field's rules belong to the capability that owns
// it (metadata for the record's own settings, secrets, access, and egress);
// what lives here is the part no single capability can provide: validating a whole request before the
// first write, applying the fields in a fixed order, and accounting for what landed.
import { getStore } from "@/lib/infra/services";
import type { ReasoningEffort } from "@/lib/models/llmSelection";
import { metadataWrites, validateMetadata, type MetadataWriter, type WorkspaceMetadataInput } from "./metadata";
import { currentModelSelection, publicModelSelection, type WorkspaceLookup } from "./read";
import { setChannelEnabled, validateChannelEnabled, type ChannelCredentials } from "./access";
import { setInternetAccess, validateInternetAccess, type EgressServices, type EgressWriter } from "./egress";
import {
  storeWorkspaceSecret,
  validateSecret,
  type SecretStore,
  type ThirdPartySecret,
  type WorkspaceSecretInput,
} from "./secrets";
import { WorkspaceUpdateFailure } from "./errors";

/**
 * Everything a caller may change in one request, assembled from the capabilities that own each field.
 * Omitted fields are unchanged, including an omitted description; an explicitly empty description
 * clears it.
 */
export type UpdateWorkspaceInput = WorkspaceMetadataInput & {
  internetAccess?: boolean;
  workspaceApiAccess?: boolean;
  workspaceMcpAccess?: boolean;
  secret?: WorkspaceSecretInput;
};

export interface UpdateWorkspaceResult {
  ok: true;
  workspaceId: string;
  /** Capability fields successfully applied, in deterministic application order. */
  applied: Array<keyof WorkspaceUpdateValues>;
  /**
   * Canonical values established by the write. These come from the shared validators, never from a
   * transport echo, so every adapter reports trimmed, resolved and otherwise normalized values alike.
   * A stored third-party secret is represented only by its safe metadata; its value is never echoed.
   */
  values: WorkspaceUpdateValues;
}

export type WorkspaceUpdateValues = {
  name?: string;
  description?: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
  internetAccess?: boolean;
  workspaceApiAccess?: boolean;
  workspaceMcpAccess?: boolean;
  secret?: ThirdPartySecret;
};

/** The store surface an update needs: the record's own setters, plus egress, plus the lookup. */
export type UpdateWorkspaceStore = WorkspaceLookup & MetadataWriter & EgressWriter;

/** Per-capability seams, each defaulting to the real system. Tests override only what they assert on. */
export interface UpdateWorkspaceDeps {
  store?: UpdateWorkspaceStore;
  credentials?: ChannelCredentials;
  egress?: EgressServices;
  secrets?: SecretStore;
}

/**
 * Applies mutable workspace settings through one trigger-neutral entry point. Returns null when the
 * workspace does not exist, so adapters can translate that into their native not-found result.
 *
 * Every supplied value is checked before the first write. That ordering is the contract, not an
 * implementation detail: a request carrying one bad field changes nothing at all, so a caller never has
 * to reason about which half of its request survived.
 *
 * No field here produces a credential. `workspaceApiAccess` and `workspaceMcpAccess` open and close
 * their channels and nothing more; issuing a key is its own explicit operation on the channel's route,
 * so this result never carries a plaintext secret.
 */
export async function updateWorkspace(
  id: string,
  input: UpdateWorkspaceInput,
  deps: UpdateWorkspaceDeps = {},
): Promise<UpdateWorkspaceResult | null> {
  const store = deps.store ?? getStore();
  const existing = store.getWorkspace(id);
  if (!existing) return null;

  // Phase one: validate everything, touch nothing.
  const metadata = validateMetadata(input, currentModelSelection(existing));
  const internetAccess = input.internetAccess === undefined ? undefined : validateInternetAccess(input.internetAccess);
  const apiAccess =
    input.workspaceApiAccess === undefined
      ? undefined
      : validateChannelEnabled("workspaceApiAccess", input.workspaceApiAccess);
  const mcpAccess =
    input.workspaceMcpAccess === undefined
      ? undefined
      : validateChannelEnabled("workspaceMcpAccess", input.workspaceMcpAccess);
  const secretInput = input.secret === undefined ? undefined : validateSecret(input.secret);

  // Phase two: apply. Past this point the workspace is known to exist, and every store setter refuses
  // only for an unknown id — so a refusal here means the workspace was deleted mid-update. Returning
  // null would reach the caller as "no such workspace", which reads as "nothing happened" even though
  // earlier fields already landed. Name what was applied instead, so a caller can tell a no-op from a
  // half-done update.
  const appliedFields: Array<keyof WorkspaceUpdateValues> = [];
  // Takes the field names a write establishes rather than one name: `model` is a single store write
  // that settles three public fields, and a refusal has to name all of them or it reports a partial
  // change as a complete one.
  const applied = (fields: Array<keyof WorkspaceUpdateValues>, ok: boolean): void => {
    if (!ok) {
      throw new WorkspaceUpdateFailure(
        `workspace was deleted while updating; applied: ${appliedFields.join(", ") || "nothing"}; not applied: ${fields.join(", ")}`,
      );
    }
    appliedFields.push(...fields);
  };

  // Resolved once and reused for the receipt below, so the projection cannot drift between what the
  // update claims it applied and the values it reports.
  const modelValues = metadata.model === undefined ? undefined : publicModelSelection(metadata.model);
  const modelFields = Object.keys(modelValues ?? {}) as Array<keyof WorkspaceUpdateValues>;

  for (const { field, write } of metadataWrites(id, metadata, store)) {
    applied(field === "model" ? modelFields : [field], await write());
  }

  if (internetAccess !== undefined) {
    const egress = await setInternetAccess(id, internetAccess, existing.internetAccess, store, deps.egress);
    applied(["internetAccess"], egress.applied);
  }

  // These three write through capabilities that raise rather than return a flag, so reaching the next
  // line is itself the success signal — hence `true` rather than a result to check.
  if (apiAccess !== undefined) {
    setChannelEnabled("workspace-api", id, apiAccess, deps.credentials);
    applied(["workspaceApiAccess"], true);
  }
  if (mcpAccess !== undefined) {
    setChannelEnabled("workspace-mcp", id, mcpAccess, deps.credentials);
    applied(["workspaceMcpAccess"], true);
  }

  let secret: ThirdPartySecret | undefined;
  if (secretInput !== undefined) {
    secret = storeWorkspaceSecret(id, secretInput, store, deps.secrets);
    applied(["secret"], true);
  }

  return {
    ok: true,
    workspaceId: id,
    applied: appliedFields,
    values: {
      ...(metadata.name !== undefined ? { name: metadata.name } : {}),
      ...(metadata.description !== undefined ? { description: metadata.description } : {}),
      ...(metadata.maxIterations !== undefined ? { maxIterations: metadata.maxIterations } : {}),
      ...(metadata.maxRunMinutes !== undefined ? { maxRunMinutes: metadata.maxRunMinutes } : {}),
      ...(modelValues ?? {}),
      ...(internetAccess !== undefined ? { internetAccess } : {}),
      ...(apiAccess !== undefined ? { workspaceApiAccess: apiAccess } : {}),
      ...(mcpAccess !== undefined ? { workspaceMcpAccess: mcpAccess } : {}),
      ...(secret ? { secret } : {}),
    },
  };
}
