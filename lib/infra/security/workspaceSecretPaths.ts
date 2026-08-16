import path from "path";

export const WORKSPACE_SECRET_VAULT_ROOT =
  process.env.PAODO_WORKSPACE_SECRET_VAULT_ROOT ?? path.resolve(process.cwd(), ".paodo-workspace-secret-vault");

export const WORKSPACE_SECRET_VAULT_KEY_FILE =
  process.env.PAODO_WORKSPACE_SECRET_KEY_FILE ??
  path.resolve(process.cwd(), ".paodo-workspace-secret-key", "master.key");
