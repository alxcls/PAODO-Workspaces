export class WorkspaceRunTimeoutError extends Error {
  readonly code = "TIMEOUT" as const;

  constructor(
    readonly workspaceId: string,
    readonly workspaceName: string,
    readonly maxRunMinutes: number,
  ) {
    super(`Workspace "${workspaceName}" exceeded its ${maxRunMinutes}-minute execution limit.`);
    this.name = "WorkspaceRunTimeoutError";
  }
}

export interface WorkspaceRunTimeout {
  /** The workspace timer combined with any parent/user cancellation signals. */
  signal: AbortSignal;
  /** True only when this workspace's own timer fired, not when an ancestor/user cancelled it. */
  didTimeout: () => boolean;
  error: WorkspaceRunTimeoutError;
  dispose: () => void;
}

/** Creates a disposable wall-clock timer for one workspace run. */
export function createWorkspaceRunTimeout(
  workspace: { id: string; name: string; maxRunMinutes: number },
  parentSignals: Array<AbortSignal | undefined> = [],
): WorkspaceRunTimeout {
  const timeout = new AbortController();
  const error = new WorkspaceRunTimeoutError(workspace.id, workspace.name, workspace.maxRunMinutes);
  const timer = setTimeout(() => timeout.abort(error), workspace.maxRunMinutes * 60_000);
  // A completed run must not keep a Node process alive merely because its safety timer remains.
  timer.unref?.();

  const signals = [timeout.signal, ...parentSignals.filter((s): s is AbortSignal => Boolean(s))];
  return {
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    didTimeout: () => timeout.signal.aborted,
    error,
    dispose: () => clearTimeout(timer),
  };
}
