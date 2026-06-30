// Formats the per-file permission state for the agent: short tags ([R]/[H]/[P]) and the system-prompt
// block listing every protected path. The agent reads these so it explains a restriction (and names
// the icon the user should click) instead of failing confusingly or trying to work around it.
import { getPermissions, normalizePermPath } from "../../infra/permissionStore";

// Tags for a single path, in the order [write][visibility][privilege]. Privilege implies lock, so a
// [P] path is not also shown as [R] (privilege is the stronger, more specific marker). Returns "" for
// an unprotected path.
export function protectionTagsFor(workspaceId: string, relPath: string): string {
  const key = normalizePermPath(relPath);
  if (key === null) return "";
  const perms = getPermissions(workspaceId);
  const tags: string[] = [];
  if (perms.privileged.includes(key)) tags.push("[P]");
  else if (perms.locked.includes(key)) tags.push("[R]");
  if (perms.hidden.includes(key)) tags.push("[H]");
  return tags.join("");
}

// The "Protected files" block injected into the system prompt. Returns undefined when nothing is
// protected so the common case keeps the prompt lean.
export function buildProtectionBlock(workspaceId: string): string | undefined {
  const perms = getPermissions(workspaceId);
  if (!perms.locked.length && !perms.hidden.length && !perms.privileged.length) return undefined;

  // privilege implies lock; show each path once under its strongest tag.
  const privileged = new Set(perms.privileged);
  const lines: string[] = [];
  for (const p of [...perms.privileged].sort()) lines.push(`${p}  [P]`);
  for (const p of [...perms.locked].sort()) if (!privileged.has(p)) lines.push(`${p}  [R]`);
  for (const p of [...perms.hidden].sort()) lines.push(`${p}  [H]`);

  return `# Protected files (set by the user — you cannot change these states)
The user controls these protections from the file tree; you have NO tool to lock, hide, or privilege a path. When a protection blocks you, explain it and name the icon to click — never try to work around it (e.g. via a script you write and run; the protections are kernel-enforced and apply to your scripts too).
- [R] read-only: you may read and run it, but cannot modify or delete it.
- [H] hidden: you cannot read its content; only its name may appear in listings.
- [P] privileged: a trusted, locked script you may run ONLY via run_privileged_script — it runs with rights to read [H] files and write [R] files. You cannot edit it.

Protected paths:
${lines.join("\n")}`;
}
