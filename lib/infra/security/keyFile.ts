// Generate a host-only secret key and persist it with owner-only permissions (0600). Centralized
// so every place that mints an at-rest key file (the proxy HMAC key, the secrets-encryption key)
// gets the restrictive mode bits right — a missed chmod on any of them would leak the key to other
// host users. Callers own the read/caching/"regenerate on corrupt" policy around it, which differs
// between the startup-provisioned proxy key and the lazily-provisioned secrets key.
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";

export function createKeyFile(filePath: string, bytes = 32): Buffer {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const key = randomBytes(bytes);
  writeFileSync(filePath, key, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return key;
}
