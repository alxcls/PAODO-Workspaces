import path from "path";

export const PROVIDER_VAULT_ROOT =
  process.env.PAODO_PROVIDER_VAULT_ROOT ?? path.resolve(process.cwd(), ".paodo-provider-vault");

export const PROVIDER_VAULT_KEY_FILE =
  process.env.PAODO_PROVIDER_KEY_FILE ?? path.resolve(process.cwd(), ".paodo-provider-key", "master.key");
