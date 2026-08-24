// The complete trigger-neutral drive read, the mirror of lib/operations/workspace/overview.ts.
//
// Separate from manage.ts's getDrive because that one answers the registry's question — does this
// drive exist, and what is it called — and is what update and delete resolve against. This answers a
// caller's, and a caller reading one drive wants to know whether anything is using it.
import { getDrive } from "./manage";
import { driveConnectionCounts, type DriveConnectionCounts } from "../connections/counts";
import type { Drive } from "@/lib/drives/store";

export type DriveOverview = Drive & {
  /** How many workspaces reach this drive, not which: the connection listing owns the detail and the
   *  id a link is removed by. Present at zero, so nothing is connected is stated rather than inferred. */
  connections: DriveConnectionCounts;
};

export function getDriveOverview(driveIdValue: unknown): DriveOverview {
  const drive = getDrive(driveIdValue);
  return { ...drive, connections: driveConnectionCounts(drive.id) };
}
