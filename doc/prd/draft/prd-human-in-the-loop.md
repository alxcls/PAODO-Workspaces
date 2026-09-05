# PRD — Human in the Loop

**Status:** Draft  
**Author:** @alxcls  
**Related:** [VISION.md](../../VISION.md), [Agent network](../accepted/prd-agent-network.md), [Agent loop control](../accepted/prd-agent-loop-control.md)

---

## Problem

Workspaces execute agent actions autonomously. Owners need a way to supervise selected workspaces while others continue independently, without relying on the agent to remember to ask permission or returning to each conversation to approve work.

## Goals

- Let owners choose human oversight per workspace.
- Enforce approval before actions execute, independently of agent instructions.
- Keep routine work automatic through explicit, scoped permissions.
- Make pending decisions and the work they block visible across workspaces.

## Non-goals

- AI-based approval classification or automatic expansion of permissions.
- Per-user roles, approval chains, or external notification integrations.
- Guaranteeing each effect of an approved script or background process.

## User stories

> As an owner, I want a “Human in the loop” checkbox on each workspace so that I can choose which responsibilities require supervision.

> As a reviewer, I want to inspect and approve proposed actions without reconstructing the agent's conversation.

> As an owner, I want to authorize recurring actions explicitly so that trusted work requires fewer interruptions.

## Requirements

### Must have

- Each workspace has a “Human in the loop” checkbox, off by default; existing workspaces remain autonomous.
- When enabled, each proposed tool action is allowed, denied, or submitted for human approval according to workspace permissions and the action's inputs.
- Reading, discovery, and planning proceed automatically; mutations, shell execution, outbound requests, and agent delegation require approval unless explicitly permitted.
- Explicit denial takes precedence over permission to execute; unresolved actions require approval.
- Approval is enforced before execution and cannot be granted or bypassed by the agent.
- The same workspace policy applies to chat, schedules, API, MCP, and agent graph calls.
- Receiving workspaces enforce their own permissions; approving delegation does not approve the receiving agent's subsequent actions.
- Pending requests identify the workspace, proposed action, exact inputs, and relevant evidence: commands, file diffs, or destination skills and their inputs.
- Reviewers can approve once, reject with feedback, or explicitly create a scoped permission for future matching actions.
- Approval applies only to the reviewed action; changes to its inputs or reviewed content require a new decision.
- Requests persist while waiting. Dependent agent work pauses without further model calls; unrelated workspaces continue.
- Pending decisions are accessible from the workspace, graph, and a shared review panel, with blocked work identified.
- Approval resumes the pending action; rejection returns clear feedback without executing it.
- Requests can be cancelled and have an expiry; silence never grants approval, and cancelled or expired requests cannot execute.
- Human decisions and automatic permission outcomes appear in execution history with their reasons.
- Reviews clearly distinguish authorizing a command or background process from approving each effect it may produce.
- The user's stop control remains available while work is running or awaiting approval.

### Nice to have

- Review several pending actions together while retaining an individual decision for each.
- Show approval history to help owners decide when to revise permissions or grant autonomy.
