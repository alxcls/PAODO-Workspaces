// Production singleton for workspace versioning. Exported from its own module (rather than
// services.ts) so leaf modules like workspaceStore.ts can wire it in without importing services.ts
// and creating an import cycle.
import { WorkspaceVersioning } from "./workspaceVersioning";

export const defaultWorkspaceVersioning = new WorkspaceVersioning();
