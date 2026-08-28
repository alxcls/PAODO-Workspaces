// Every storage root falls back to a directory under process.cwd() when its env var is unset, which
// in a test run is the repo itself. Unset, a suite reads and writes the developer's own database,
// vaults and workspaces, and leaves .paodo-* directories behind. Give each test file a temp root.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const root = mkdtempSync(path.join(tmpdir(), "paodo-test-"));

process.env.WORKSPACES_ROOT = root;
// The app runs only against the workspaces volume, so the suite's default shape is the deployed one.
// Nothing here reaches Docker: the name is only ever formatted into --mount arguments and asserted.
process.env.WORKSPACES_VOLUME_NAME = "paodo_ws_workspaces";
process.env.PAODO_PROVIDER_VAULT_ROOT = path.join(root, "provider-vault");
process.env.PAODO_PROVIDER_KEY_FILE = path.join(root, "provider-key", "master.key");
process.env.PAODO_WORKSPACE_SECRET_VAULT_ROOT = path.join(root, "workspace-secret-vault");
process.env.PAODO_WORKSPACE_SECRET_KEY_FILE = path.join(root, "workspace-secret-key", "master.key");
