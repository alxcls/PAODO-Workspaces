// The connection listing: both graphs read together and every end named, whole or narrowed to one id.
// The two stores stay apart underneath; this only reads them, so a client relays instead of joining.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { getGraph, type GraphEdge } from "@/lib/agent/graph";
import { listConnections, listDrives, type DriveConnection } from "@/lib/drives/store";
import { getStore } from "@/lib/infra/services";

/**
 * One end of a listed connection. `name` is null when nothing answers to the id any more: neither
 * store refuses an id on write, so a dangling row is listed rather than dropped — its id is the only
 * handle a caller has to remove it by.
 */
export interface ListedEnd {
  id: string;
  name: string | null;
}

/** The subject of a narrowed listing, which exists by construction. */
interface NamedEnd {
  id: string;
  name: string;
}

export interface AllConnections {
  driveLinks: Array<{ id: string; drive: ListedEnd; workspace: ListedEnd }>;
  agentCalls: Array<{ id: string; caller: ListedEnd; callee: ListedEnd }>;
}

/** Grouped under the words `workspace get` counts them by, each row holding only its far end. */
export interface WorkspaceConnections {
  workspace: NamedEnd;
  drives: Array<{ id: string; drive: ListedEnd }>;
  callers: Array<{ id: string; caller: ListedEnd }>;
  callees: Array<{ id: string; callee: ListedEnd }>;
}

/** A drive has no agent calls, so `workspaces` is the whole of what it can hold. */
export interface DriveConnections {
  drive: NamedEnd;
  workspaces: Array<{ id: string; workspace: ListedEnd }>;
}

export type ConnectionListing = AllConnections | WorkspaceConnections | DriveConnections;

export interface ConnectionListDeps {
  workspaces(): NamedEnd[];
  drives(): NamedEnd[];
  links(): DriveConnection[];
  edges(): GraphEdge[];
}

function defaultDeps(): ConnectionListDeps {
  return {
    workspaces: () => getStore().listWorkspaces(),
    drives: listDrives,
    links: listConnections,
    edges: () => getGraph().edges,
  };
}

type Names = Map<string, string>;

function namesById(items: NamedEnd[]): Names {
  return new Map(items.map((item) => [item.id, item.name]));
}

function end(id: string, names: Names): ListedEnd {
  return { id, name: names.get(id) ?? null };
}

/** Ordered by the names a row joins, then its id: ids are minted, so they only break a tie. */
function byNames<Row extends { id: string }>(rows: Row[]): Row[] {
  const key = (row: Row) =>
    Object.values(row)
      .map((value) => (typeof value === "object" && value !== null ? ((value as ListedEnd).name ?? "") : ""))
      .join(" ");
  return [...rows].sort((a, b) => key(a).localeCompare(key(b), "en") || a.id.localeCompare(b.id, "en"));
}

/**
 * Every connection of both kinds, or with `forId` only those touching that workspace or drive. An id
 * neither registry holds is refused rather than answered with an empty listing: nothing connected and
 * no such thing would otherwise read alike.
 */
export function connectionListing(forId?: unknown, deps: ConnectionListDeps = defaultDeps()): ConnectionListing {
  const workspaceNames = namesById(deps.workspaces());
  const driveNames = namesById(deps.drives());
  const links = deps.links();
  const edges = deps.edges();

  if (forId === undefined) {
    return {
      driveLinks: byNames(
        links.map((link) => ({
          id: link.id,
          drive: end(link.driveId, driveNames),
          workspace: end(link.workspaceId, workspaceNames),
        })),
      ),
      agentCalls: byNames(
        edges.map((edge) => ({
          id: edge.id,
          caller: end(edge.source, workspaceNames),
          callee: end(edge.target, workspaceNames),
        })),
      ),
    };
  }

  const id = requireNonEmptyString(forId, "for");
  const workspace = workspaceNames.get(id);
  if (workspace !== undefined) {
    return {
      workspace: { id, name: workspace },
      drives: byNames(
        links
          .filter((link) => link.workspaceId === id)
          .map((link) => ({ id: link.id, drive: end(link.driveId, driveNames) })),
      ),
      callers: byNames(
        edges
          .filter((edge) => edge.target === id)
          .map((edge) => ({ id: edge.id, caller: end(edge.source, workspaceNames) })),
      ),
      callees: byNames(
        edges
          .filter((edge) => edge.source === id)
          .map((edge) => ({ id: edge.id, callee: end(edge.target, workspaceNames) })),
      ),
    };
  }
  const drive = driveNames.get(id);
  if (drive !== undefined) {
    return {
      drive: { id, name: drive },
      workspaces: byNames(
        links
          .filter((link) => link.driveId === id)
          .map((link) => ({ id: link.id, workspace: end(link.workspaceId, workspaceNames) })),
      ),
    };
  }
  throw new AppError("NOT_FOUND", `no workspace or drive has the id ${id}`, { field: "for" });
}
