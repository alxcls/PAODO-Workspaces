// The shape a snapshot ref must have before it reaches the git client's argv.
//
// Defense-in-depth: gitClient passes arguments as an argv array with no shell, so this is not what
// stands between a caller and command injection. It is here because a ref is the one git argument
// that arrives verbatim from an HTTP request, and a value that cannot be a sha is better refused by
// name than handed to git to fail on. Co-located with the client whose input it describes so the
// restore operation and the diff route validate against one definition.

/** Abbreviated or full hex object name, matching what `git log --format=%h` and `%H` produce. */
const SNAPSHOT_SHA = /^[0-9a-fA-F]{4,40}$/;

export function isSnapshotSha(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_SHA.test(value);
}
