// Single source of truth for the workspaces root directory; override with WORKSPACES_ROOT env var in production.
import path from "path";
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
