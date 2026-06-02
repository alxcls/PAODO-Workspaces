// Builds the three independent permission tags shown to the agent on every file/folder, in the
// order [write] [privilege] [visibility]:
//   write     → [RW] read-write  | [R] read-only
//   privilege → [US] normal      | [S] elevated (runs as root with secrets injected)
//   visibility → [V]  visible    | [H] hidden (content unreadable by the agent)
//
// All three states are independent — the write tag reflects only the lock toggle, not hidden/privilege.
export function permissionTags(state: { locked: boolean; privileged: boolean; hidden: boolean }): string {
  const write = state.locked ? "[R]" : "[RW]";
  const privilege = state.privileged ? "[S]" : "[US]";
  const visibility = state.hidden ? "[H]" : "[V]";
  return `${write} ${privilege} ${visibility}`;
}

// Pure path check against pre-fetched lists, mirroring isLocked/isPrivileged/isHidden prefix semantics
// (a path is covered if it equals an entry or lives under an entry directory).
export function isCovered(relPath: string, entries: string[]): boolean {
  return entries.some((p) => p === relPath || relPath.startsWith(p + "/"));
}
