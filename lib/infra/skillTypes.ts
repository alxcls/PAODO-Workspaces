// Types for a workspace skill definition — one JSON file per skill under
// data/<workspace-name>/skills/. A skill is a named action with a typed input
// (`parameters`) and a typed output (`output`), both expressed as JSON Schema.
// The platform enforces both sides of the contract in executeSkill.

/** Loose JSON Schema shape — we validate with ajv at runtime, not at the type level. */
export interface SkillSchema {
  type?: string;
  properties?: Record<string, SkillSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface SkillSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface SkillDefinition {
  /** Stable machine key referenced as `action` in call_agent. */
  id: string;
  /** Human label. */
  name: string;
  description: string;
  /** JSON Schema for the input args — validated before the callee runs. */
  parameters: SkillSchema;
  /** JSON Schema for the response — validated before the caller sees the result. */
  output: SkillSchema;
}

/** Result of a skill call, returned by executeSkill. */
export type SkillCallResult =
  | { state: "completed"; output: Record<string, unknown> }
  | { state: "failed"; code: SkillErrorCode; message: string };

export type SkillErrorCode =
  | "NOT_CONNECTED"
  | "SKILL_NOT_FOUND"
  | "INPUT_VALIDATION_ERROR"
  | "OUTPUT_VALIDATION_ERROR"
  | "EXECUTION_ERROR";
