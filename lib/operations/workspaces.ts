// The workspace record itself: its public projections, its creation, and the settings stored directly
// on it — name, description, iteration and runtime limits, model choice. Read and write live together
// so the shape a caller reads back is defined beside the rules that let a value be written.
//
// Capabilities that are more than a registry field get their own file: workspaceSecrets,
// workspaceAccess, workspaceEgress, workspaceSkills, workspaceDelete. The unified update contract
// that dispatches across all of them is workspaceUpdate.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { DEFAULT_LLM, type ReasoningEffort } from "@/lib/agent/interfaces";
import { getProviderMetadata, SUPPORTED_PROVIDERS } from "@/lib/agent/buildModel";
import type { Workspace } from "@/lib/workspace/workspaceStore";
import { listModels } from "@/lib/workspace/models";
import {
  resolveModelSelection,
  type ModelSelection,
  type ModelVocabulary,
  type RequestedModelSelection,
} from "@/lib/workspace/modelSelection";
import { validateWorkspaceName } from "@/lib/workspace/workspaceName";
import {
  MAX_MAX_ITERATIONS,
  MAX_MAX_RUN_MINUTES,
  MIN_MAX_ITERATIONS,
  MIN_MAX_RUN_MINUTES,
} from "@/lib/workspace/workspaceLimits";
import { WorkspaceUpdateError } from "./workspaceErrors";

export interface WorkspaceSummary {
  id: string;
  name: string;
  description: string;
}

export interface CreateWorkspaceInput {
  name: string;
}

export interface WorkspaceDetails extends WorkspaceSummary {
  createdAt: Date;
  maxIterations: number;
  maxRunMinutes: number;
  internetAccess: boolean;
  llmProvider: string;
  llmModel: string;
  reasoningEffort: ReasoningEffort;
  /**
   * Whether `reasoningEffort` means anything for this provider. False for providers with no effort
   * dial (DeepSeek gates reasoning by model name): the stored value is a placeholder the agent never
   * sends, and the UI hides the control. Programmatic callers need this to tell "effort is low" from
   * "effort does not apply" without hardcoding provider capabilities.
   */
  reasoningEffortSupported: boolean;
}

/** The metadata fields of the update contract, as a caller supplies them — unvalidated. */
export interface WorkspaceMetadataInput {
  name?: string;
  description?: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  /**
   * Any subset of the three model fields. What is omitted is resolved from the workspace's current
   * choice and the provider's catalog, the same way the picker resolves it — so naming just a provider
   * is a complete request.
   */
  model?: RequestedModelSelection;
}

/** The same fields once checked and canonicalized: safe to hand to the store as-is. */
export interface WorkspaceMetadata {
  name?: string;
  description?: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  model?: ModelSelection;
}

export interface ValidatedMetadata {
  metadata: WorkspaceMetadata;
  /** Supplied values that could not be honored, for the caller to pass on. Never a silent drop. */
  warnings: string[];
}

/**
 * The vocabulary the shared resolver needs, read from the two code-owned catalogs: model names from
 * lib/workspace/models.ts, effort levels from the provider registry. GET /api/models serves this same
 * pair to the picker, which is what keeps the two surfaces resolving against identical data.
 */
function providerVocabulary(provider: string): ModelVocabulary {
  return { models: listModels(provider), reasoningEfforts: getProviderMetadata(provider).reasoningEfforts };
}

/** A workspace's stored model choice, with the defaults applied for fields it never set. */
export function currentModelSelection(workspace: Workspace): ModelSelection {
  return {
    provider: workspace.llmProvider ?? DEFAULT_LLM.provider,
    model: workspace.llmModel ?? DEFAULT_LLM.model,
    reasoningEffort: workspace.reasoningEffort ?? DEFAULT_LLM.reasoningEffort,
  };
}

export type WorkspaceReader = Pick<IWorkspaceStore, "getWorkspace" | "listWorkspaces">;
export type WorkspaceLookup = Pick<IWorkspaceStore, "getWorkspace">;
export type MetadataWriter = Pick<
  IWorkspaceStore,
  | "renameWorkspace"
  | "setWorkspaceDescription"
  | "setWorkspaceMaxIterations"
  | "setWorkspaceMaxRunMinutes"
  | "setWorkspaceLlm"
>;

function summary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description ?? "",
  };
}

export function listWorkspaces(store: WorkspaceReader = getStore()): WorkspaceSummary[] {
  return store.listWorkspaces().map(summary);
}

/**
 * Creates a workspace and returns the same public projection used by the collection query. Name
 * validation and canonicalization happen before the store is touched so every future trigger gets
 * the same behavior; the store intentionally validates again at its persistence boundary.
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  store: Pick<IWorkspaceStore, "createWorkspace"> = getStore(),
): Promise<WorkspaceSummary> {
  const name = validateWorkspaceName(input.name);
  return summary(await store.createWorkspace(name));
}

export function getWorkspace(id: string, store: WorkspaceLookup = getStore()): WorkspaceDetails | null {
  const workspace = store.getWorkspace(id);
  if (!workspace) return null;
  const llmProvider = workspace.llmProvider ?? DEFAULT_LLM.provider;
  return {
    ...summary(workspace),
    createdAt: workspace.createdAt,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
    llmProvider,
    llmModel: workspace.llmModel ?? DEFAULT_LLM.model,
    reasoningEffort: workspace.reasoningEffort ?? DEFAULT_LLM.reasoningEffort,
    reasoningEffortSupported: getProviderMetadata(llmProvider).reasoningEfforts.length > 0,
  };
}

/**
 * Checks and canonicalizes every supplied metadata field, touching nothing. Pure so the caller can
 * validate a whole request before its first write — see workspaceUpdate for why that ordering is the
 * contract rather than an implementation detail.
 *
 * Out-of-range numbers are rejected rather than clamped, and the message states the accepted range:
 * callers with no form to validate against — the CLI, scripts, an agent — otherwise get "ok" back for
 * a value we silently replaced.
 *
 * `current` is the workspace's existing model choice, which a partial model request resolves against.
 * It defaults to DEFAULT_LLM so a caller validating a request with no workspace in hand still gets the
 * same answer a fresh workspace would.
 */
export function validateMetadata(
  input: WorkspaceMetadataInput,
  current: ModelSelection = DEFAULT_LLM,
): ValidatedMetadata {
  const metadata: WorkspaceMetadata = {};
  const warnings: string[] = [];

  if (input.name !== undefined) metadata.name = validateWorkspaceName(input.name);
  if (input.description !== undefined) metadata.description = input.description.trim();

  if (input.maxIterations !== undefined) {
    const value = Math.floor(Number(input.maxIterations));
    if (!Number.isFinite(value) || value < MIN_MAX_ITERATIONS || value > MAX_MAX_ITERATIONS) {
      throw new WorkspaceUpdateError(`maxIterations must be between ${MIN_MAX_ITERATIONS} and ${MAX_MAX_ITERATIONS}`);
    }
    metadata.maxIterations = value;
  }

  if (input.maxRunMinutes !== undefined) {
    const value = Math.floor(Number(input.maxRunMinutes));
    if (!Number.isFinite(value) || value < MIN_MAX_RUN_MINUTES || value > MAX_MAX_RUN_MINUTES) {
      throw new WorkspaceUpdateError(`maxRunMinutes must be between ${MIN_MAX_RUN_MINUTES} and ${MAX_MAX_RUN_MINUTES}`);
    }
    metadata.maxRunMinutes = value;
  }

  if (input.model !== undefined) {
    // A present-but-blank field is a caller error, not an omission: resolution treats blank as "not
    // supplied" and would quietly substitute a default for a value the caller did try to set. Checked
    // before resolution so these keep naming the accepted values rather than reporting the substitute.
    const blank = (value: string | undefined): boolean => value !== undefined && !value.trim();
    if (blank(input.model.provider)) {
      throw new WorkspaceUpdateError(`llmProvider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
    }
    if (blank(input.model.model)) throw new WorkspaceUpdateError("llmModel required");

    // Fill the gaps, then check what came out. Resolution is shared with the picker so a partial choice
    // means the same thing here as it does in the UI; see lib/workspace/modelSelection.ts.
    const { selection, warnings: modelWarnings } = resolveModelSelection(input.model, current, providerVocabulary);

    // Both rejections name the accepted values. The valid effort levels differ per provider, so a
    // caller cannot know them ahead of the provider choice — carrying them in the error is the only
    // place the answer is both correct and available without a second lookup.
    if (!SUPPORTED_PROVIDERS.includes(selection.provider)) {
      throw new WorkspaceUpdateError(`llmProvider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
    }
    // Only reachable for a supported provider serving no models that the workspace was not already on —
    // resolution supplies a model in every other case.
    if (!selection.model) throw new WorkspaceUpdateError("llmModel required");

    // The pair has to be coherent, not merely well-formed: a model belongs to exactly one provider, and
    // storing someone else's — or a typo — buys a selection that only fails later, when the run reaches
    // the provider. The picker cannot express an incoherent pair (its model list is the selected
    // provider's catalog), so this is what gives a programmatic caller the same guarantee.
    const models = providerVocabulary(selection.provider).models;
    if (!models.includes(selection.model)) {
      throw new WorkspaceUpdateError(`llmModel for ${selection.provider} must be one of: ${models.join(", ")}`);
    }

    // An effort the caller named that the provider does not accept is refused rather than replaced: a
    // caller with no dropdown constraining it would otherwise read "ok" for a value we substituted. An
    // omitted one cannot land here — resolution only ever picks a level the provider accepts.
    const efforts = providerVocabulary(selection.provider).reasoningEfforts;
    const named = input.model.reasoningEffort?.trim();
    if (named && efforts.length > 0 && !efforts.includes(named as ReasoningEffort)) {
      throw new WorkspaceUpdateError(`reasoningEffort for ${selection.provider} must be one of: ${efforts.join(", ")}`);
    }

    metadata.model = selection;
    warnings.push(...modelWarnings);
  }

  return { metadata, warnings };
}

/**
 * The store writes that applying `metadata` requires, one per supplied field and in a fixed order.
 * Returned as descriptors rather than performed here so the caller keeps ownership of what happens
 * between them: which fields it records as applied, and how it reports a write that refuses.
 */
export function metadataWrites(
  id: string,
  metadata: WorkspaceMetadata,
  store: MetadataWriter,
): Array<{ field: keyof WorkspaceMetadata; write: () => boolean | Promise<boolean> }> {
  const writes: Array<{ field: keyof WorkspaceMetadata; write: () => boolean | Promise<boolean> }> = [];
  const { name, description, maxIterations, maxRunMinutes, model } = metadata;

  if (name !== undefined) writes.push({ field: "name", write: () => store.renameWorkspace(id, name) });
  if (description !== undefined) {
    writes.push({ field: "description", write: () => store.setWorkspaceDescription(id, description) });
  }
  if (maxIterations !== undefined) {
    writes.push({ field: "maxIterations", write: () => store.setWorkspaceMaxIterations(id, maxIterations) });
  }
  if (maxRunMinutes !== undefined) {
    writes.push({ field: "maxRunMinutes", write: () => store.setWorkspaceMaxRunMinutes(id, maxRunMinutes) });
  }
  if (model !== undefined) writes.push({ field: "model", write: () => store.setWorkspaceLlm(id, model) });

  return writes;
}
