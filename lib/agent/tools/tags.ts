// Builds the three independent permission tags shown to the agent on every file/folder, in the
// order [write] [secure] [visibility]:
//   write      → [RW] read-write  | [R] read-only
//   secure     → [US] unsecured   | [S] secured script (runs as root with secrets injected)
//   visibility → [V]  visible     | [H] hidden (content unreadable by the agent)
//
// Coupling: a hidden or secured path is always read-only, so the write tag is forced to [R] when
// either is set. Hidden and secured are mutually exclusive (enforced at the API/UI layer).
export function permissionTags(state: { locked: boolean; secured: boolean; hidden: boolean }): string {
  const write = state.locked || state.secured || state.hidden ? "[R]" : "[RW]";
  const secure = state.secured ? "[S]" : "[US]";
  const visibility = state.hidden ? "[H]" : "[V]";
  return `${write} ${secure} ${visibility}`;
}

// Pure path check against pre-fetched lists, mirroring isLocked/isSecured/isHidden prefix semantics
// (a path is covered if it equals an entry or lives under an entry directory).
export function isCovered(relPath: string, entries: string[]): boolean {
  return entries.some((p) => p === relPath || relPath.startsWith(p + "/"));
}
