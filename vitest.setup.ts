// paths.ts falls back to <cwd>/data, which in local dev is the developer's live state — the real
// database, credentials and workspaces. Point every test file at its own temp root instead.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.WORKSPACES_ROOT = mkdtempSync(path.join(tmpdir(), "paodo-test-"));
