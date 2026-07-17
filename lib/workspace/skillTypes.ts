// Types for a workspace skill definition — one JSON file per skill under
// data/<workspace-name>/.skills/. A skill is a named action with a typed input
// (`input`) and a typed output (`output`), both expressed as JSON Schema.
// The platform enforces both sides of the contract in executeSkill.

/** Loose JSON Schema shape — we validate with ajv at runtime, not at the type level. */
export interface SkillSchema {
  type?: string;
  properties?: Record<string, SkillSchemaProperty>;
  required?: string[];
  /** JSON Schema annotation: representative valid values, shown during skill discovery. */
  examples?: unknown[];
  [key: string]: unknown;
}

export interface SkillSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface SkillDefinition {
  /** Stable, human-readable key referenced as `action` in call_agent and as the MCP tool name. */
  id: string;
  description: string;
  /** JSON Schema for the input args — validated before the callee runs. */
  input: SkillSchema;
  /** JSON Schema for the response — validated before the caller sees the result. */
  output: SkillSchema;
}

/**
 * Result of a skill call, returned by executeSkill. `conversationId` is the id of the persisted
 * conversation in the CALLEE's workspace for this run — present whenever the callee actually ran
 * (completed, or failed after starting), absent for pre-run rejections (NOT_CONNECTED,
 * SKILL_NOT_FOUND, INPUT_VALIDATION_ERROR). It is UI metadata for deep-linking, never shown to
 * the calling model.
 */
export type SkillCallResult =
  | { state: "completed"; output: Record<string, unknown>; conversationId?: string }
  | { state: "failed"; code: SkillErrorCode; message: string; conversationId?: string };

export type SkillErrorCode =
  | "NOT_CONNECTED"
  | "SKILL_NOT_FOUND"
  | "INPUT_VALIDATION_ERROR"
  | "OUTPUT_VALIDATION_ERROR"
  | "NEEDS_INPUT"
  | "TIMEOUT"
  | "CANCELLED"
  | "EXECUTION_ERROR";

/**
 * Reserved output key: a callee that cannot resolve schema-valid args (typo'd id,
 * ambiguous value) replies `{ "_needs_input": "<question>" }` instead of the output
 * schema. executeSkill intercepts it before output validation and surfaces it to the
 * caller as a NEEDS_INPUT failure so the caller can re-call with corrected args.
 */
export const NEEDS_INPUT_KEY = "_needs_input";
