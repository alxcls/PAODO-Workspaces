import { CredentialProxy } from "./credentialProxy";

const g = global as typeof global & { _credentialProxy?: CredentialProxy };
if (!g._credentialProxy) g._credentialProxy = new CredentialProxy();

export function getCredentialProxy(): CredentialProxy {
  return g._credentialProxy!;
}
