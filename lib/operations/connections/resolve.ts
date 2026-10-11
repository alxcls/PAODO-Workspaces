// One entry point over both connection graphs, for a caller that holds two ids and no canvas.
//
// What a pair of ids makes — a drive link or an agent call — is decided by what the ids are, and which
// pairs are refused is decided here too, so a client relays the answer instead of restating the rule.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { connectionKind } from "@/lib/connections/ids";
import { getDrive } from "@/lib/drives/store";
import { getStore } from "@/lib/infra/services";
import { connectDriveToWorkspace, disconnectDriveFromWorkspace } from "@/lib/operations/drives/connect";
import { connectWorkspaces, disconnectWorkspaces } from "@/lib/operations/graph/connect";

export interface ConnectInput {
  from?: unknown;
  to?: unknown;
}

/** One end of a connection: the id the next request takes, and the name a reader recognises. */
export interface ConnectionEnd {
  id: string;
  name: string;
}

/** What was made, its ends under the role each plays — an agent call is directed, a drive link is not. */
export type Connection =
  | { kind: "link"; id: string; drive: ConnectionEnd; workspace: ConnectionEnd }
  | { kind: "call"; id: string; caller: ConnectionEnd; callee: ConnectionEnd };

/** The lookups and the four writes, so a test asserts which graph a pair reached without either store. */
export interface ConnectionDeps {
  workspaceName(id: string): string | undefined;
  driveName(id: string): string | undefined;
  linkDrive: typeof connectDriveToWorkspace;
  unlinkDrive: typeof disconnectDriveFromWorkspace;
  connectCall: typeof connectWorkspaces;
  disconnectCall: typeof disconnectWorkspaces;
}

function defaultDeps(): ConnectionDeps {
  return {
    workspaceName: (id) => getStore().getWorkspace(id)?.name,
    driveName: (id) => getDrive(id)?.name,
    linkDrive: connectDriveToWorkspace,
    unlinkDrive: disconnectDriveFromWorkspace,
    connectCall: connectWorkspaces,
    disconnectCall: disconnectWorkspaces,
  };
}

/** A typo and a real id read alike in a request body, so an id neither registry holds is named. */
function endOf(id: string, field: "from" | "to", deps: ConnectionDeps): ConnectionEnd & { is: "workspace" | "drive" } {
  const workspace = deps.workspaceName(id);
  if (workspace !== undefined) return { is: "workspace", id, name: workspace };
  const drive = deps.driveName(id);
  if (drive !== undefined) return { is: "drive", id, name: drive };
  throw new AppError("NOT_FOUND", `no workspace or drive has the id ${id}`, { field });
}

/**
 * Connect two things, whichever two they are. A drive and a workspace make a drive link, in either
 * order; two workspaces make an agent call, the first calling the second. Both are idempotent: an
 * already-connected pair answers with the connection it has.
 */
export function connect(input: ConnectInput, deps: ConnectionDeps = defaultDeps()): Connection {
  const from = requireNonEmptyString(input.from, "from");
  const to = requireNonEmptyString(input.to, "to");
  if (from === to) {
    throw new AppError("INVALID_REQUEST", "a connection joins two different things; both ids are the same", {
      field: "to",
    });
  }
  const [first, second] = [endOf(from, "from", deps), endOf(to, "to", deps)];
  const end = ({ id, name }: ConnectionEnd): ConnectionEnd => ({ id, name });

  if (first.is === "drive" && second.is === "drive") {
    throw new AppError("INVALID_REQUEST", "two drives cannot be connected — a link joins a drive to a workspace", {
      field: "to",
    });
  }
  if (first.is === "workspace" && second.is === "workspace") {
    const edge = deps.connectCall({ source: from, target: to });
    return { kind: "call", id: edge.id, caller: end(first), callee: end(second) };
  }
  const [drive, workspace] = first.is === "drive" ? [first, second] : [second, first];
  const link = deps.linkDrive({ driveId: drive.id, workspaceId: workspace.id });
  return { kind: "link", id: link.id, drive: end(drive), workspace: end(workspace) };
}

/**
 * Remove one connection of either kind; the id says which graph holds it. `deleted: false` means
 * nothing is connected under that id now, which both graphs answer for an id already removed.
 */
export function disconnect(connectionIdValue: unknown, deps: ConnectionDeps = defaultDeps()): { deleted: boolean } {
  const connectionId = requireNonEmptyString(connectionIdValue, "connectionId");
  const kind = connectionKind(connectionId);
  if (kind === "link") return deps.unlinkDrive({ connectionId });
  if (kind === "call") return deps.disconnectCall({ connectionId });
  throw new AppError(
    "INVALID_REQUEST",
    `${connectionId} is not a connection id — a drive link starts with link_ and an agent call with call_; a workspace or drive id is not one`,
    { field: "connectionId" },
  );
}
