// Client-side lifecycle for one minted credential: load state, open/close the channel, mint (revealing
// the plaintext once), revoke. Every credential endpoint answers the same four verbs — see
// lib/api/credentialRoutes.ts — so the API-key block, the MCP block and the CLI access modal all
// drive their UI from this one hook instead of each reimplementing the same fetch/error/state dance.
"use client";

import { useCallback, useEffect, useState } from "react";

/** The credential fields every endpoint returns, matching CredentialState in credentialStore.ts. */
export interface CredentialSnapshot {
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

interface Labels {
  /** What the secret is called in user-facing messages, e.g. "key" or "secret". */
  noun: string;
  /** What the channel is called, e.g. "API access", "MCP settings", "CLI access". */
  feature: string;
}

/**
 * `TExtra` is whatever else the endpoint's GET returns alongside the credential state — the public
 * base URL, the available skills — exposed as `extra` so each caller keeps its own payload without
 * this hook knowing about any of them.
 */
export function useCredential<TExtra extends object = Record<string, never>>(
  endpoint: string,
  { noun, feature }: Labels,
  { load = true }: { load?: boolean } = {},
) {
  const [enabled, setEnabled] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [extra, setExtra] = useState<TExtra | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown, fallback: string) => setError(err instanceof Error ? err.message : fallback);

  useEffect(() => {
    if (!load) return;
    // `active` drops a response that arrives after the endpoint changed or the component unmounted,
    // so a slow request for the previous workspace cannot overwrite the current one's state.
    let active = true;
    void (async () => {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) throw new Error(`Could not load ${feature}.`);
        const body = (await response.json()) as CredentialSnapshot & TExtra;
        if (!active) return;
        setError(null);
        setEnabled(body.enabled);
        setHasSecret(body.hasSecret);
        setExtra(body as unknown as TExtra);
      } catch (err) {
        if (active) fail(err, `Could not load ${feature}.`);
      }
    })();
    return () => {
      active = false;
    };
  }, [load, endpoint, feature]);

  const toggle = useCallback(async () => {
    const next = !enabled;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) throw new Error(`Could not update ${feature}.`);
      setEnabled(next);
    } catch (err) {
      fail(err, `Could not update ${feature}.`);
    } finally {
      setBusy(false);
    }
  }, [enabled, endpoint, feature]);

  /** Mints or rotates. The returned plaintext is the only time it exists outside the server. */
  const mint = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      if (!response.ok) throw new Error(`Could not generate a ${noun}.`);
      const { plain } = (await response.json()) as { plain?: unknown };
      if (typeof plain !== "string" || !plain) throw new Error(`The server returned an invalid ${noun}.`);
      setSecret(plain);
      setHasSecret(true);
      // Minting enables the channel server-side, so mirror that rather than leaving a stale toggle.
      setEnabled(true);
    } catch (err) {
      fail(err, `Could not generate a ${noun}.`);
    } finally {
      setBusy(false);
    }
  }, [endpoint, noun]);

  const revoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      if (!response.ok) throw new Error(`Could not revoke the ${noun}.`);
      setHasSecret(false);
      setSecret(null);
    } catch (err) {
      fail(err, `Could not revoke the ${noun}.`);
    } finally {
      setBusy(false);
    }
  }, [endpoint, noun]);

  /** Hides the revealed plaintext. It is not recoverable afterwards — only rotation shows a new one. */
  const dismissSecret = useCallback(() => setSecret(null), []);

  return {
    enabled,
    hasSecret,
    secret,
    extra,
    busy,
    error,
    setError,
    toggle,
    mint,
    revoke,
    dismissSecret,
  };
}
