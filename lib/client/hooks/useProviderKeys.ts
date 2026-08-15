// Reads and writes the deployment's LLM provider API keys for the settings modal.
//
// Deliberately NOT built on useCredential, despite the family resemblance. That hook models a
// credential PAODO mints — enable, generate, rotate, reveal once, revoke — and its reveal-once step
// only makes sense because the server keeps a hash and can never show the value again. These keys go
// the other way: they come from the vendor, the server must keep them recoverable to spend them, and
// there is nothing to reveal because the user already has the value. So "rotate" is just saving a new
// one, and the shape is a plain list.
"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError } from "@/lib/client/apiError";

/** One provider's key status. Mirrors ProviderKeyStatus — never carries the key itself. */
export interface ProviderKeyStatus {
  provider: string;
  hasKey: boolean;
  createdAt?: string;
  /** Last few characters of the stored key, so two of the operator's own keys can be told apart. */
  hint?: string;
}

const ENDPOINT = "/api/settings/provider-keys";

export function useProviderKeys(load: boolean) {
  const [providers, setProviders] = useState<ProviderKeyStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reloading is a token bump rather than a callable fetch, so the request lives entirely inside the
  // effect below and can be cancelled by it. A `refresh()` that fetched directly would keep writing
  // state after the modal closed.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!load) return;
    // `active` drops a response that arrives after the modal closed or the component unmounted, so a
    // slow request cannot repopulate a list nobody is looking at — the same guard useCredential uses.
    let active = true;
    void (async () => {
      try {
        const res = await fetch(ENDPOINT);
        if (!active) return;
        if (!res.ok) {
          setError((await readApiError(res, "Could not read provider keys.")).error);
          return;
        }
        const body = (await res.json()) as { providers?: ProviderKeyStatus[] };
        if (!active) return;
        setProviders(body.providers ?? []);
        setError(null);
      } catch {
        if (active) setError("Could not reach the server.");
      }
    })();
    return () => {
      active = false;
    };
  }, [load, reloadToken]);

  // Both mutations re-read the list rather than patching it locally. The server owns `createdAt` and
  // the hint, and a locally-guessed hint that disagreed with the stored key would be worse than no
  // hint at all — it is the one field an operator uses to confirm which key is loaded.
  const save = useCallback(
    async (provider: string, apiKey: string) => {
      setBusy(provider);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(provider)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        if (!res.ok) {
          setError((await readApiError(res, "Could not save the key.")).error);
          return false;
        }
        refresh();
        return true;
      } catch {
        setError("Could not reach the server.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (provider: string) => {
      setBusy(provider);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(provider)}`, { method: "DELETE" });
        if (!res.ok) {
          setError((await readApiError(res, "Could not remove the key.")).error);
          return;
        }
        refresh();
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return { providers, busy, error, save, remove, refresh };
}
