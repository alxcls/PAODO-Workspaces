// The rendered-transcript message shape. It lives here, outside both agent/ and client/, because
// both sides speak it: lib/agent/messageSerialization.ts projects a *stored* conversation into this
// shape when the UI reopens history, and lib/client/agentTranscript.ts folds live AgentEvents into
// the same shape while a run streams. Two producers, one vocabulary — so it belongs to neither.
//
// Deliberately dependency-free: no React, no DOM, no agent runtime types.

export interface Message {
  role: "user" | "assistant" | "tool_start" | "error" | "limit_notice" | "reasoning" | "usage" | "disconnected";
  content?: string;
  toolName?: string;
  // The provider's tool_call id, when it supplied one. Identifies which bubble a later
  // tool_link/tool_result belongs to when one turn opens several bubbles for the same tool.
  toolCallId?: string;
  toolSummary?: string;
  toolDone?: boolean;
  // Set only on a completed call_agent tool bubble: deep-link to the callee's persisted session.
  calleeWorkspaceId?: string;
  calleeWorkspaceName?: string;
  calleeConversationId?: string;
  thinking?: boolean;
  inputTokensTotal?: number;
  inputTokensCacheRead?: number;
  outputTokensTotal?: number;
}
