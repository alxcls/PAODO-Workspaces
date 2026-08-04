// Client-side lifecycle for one minted credential: load state, open/close the channel, generate or
// rotate (revealing the plaintext once), revoke. Every credential endpoint answers the same four
// verbs — see lib/api/credentialRoutes.ts — so the API-key block, the MCP block and the CLI access
// modal all drive their UI from this one hook instead of each reimplementing the same fetch dance.
//
// `generate` and `rotate` are separate calls rather than one "mint whichever applies", because the
// server distinguishes them: it refuses to generate over an existing credential and refuses to rotate
// a missing one. That is what stops a click meant to create a key from silently replacing one another
// operator is still using — but it means the caller can be wrong about which applies, so a 409 here
// is treated as stale state and resolved by re-reading the server rather than shown as a dead end.
"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError, type ApiFailure } from "@/lib/client/apiError";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

/** The credential fields every endpoint returns, matching CredentialState in credentialStore.ts. */
export interface CredentialSnapshot {
  enabled: boolean;
  hasKey: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

interface Labels {
  /** What the channel is called, e.g. "API access", "MCP settings", "CLI access". */
  feature: string;
}

interface CredentialOptions {
  load?: boolean;
  /**
   * Which field of the shared workspace update receipt carries this channel's confirmed on/off state.
   * Workspace toggles answer with that receipt rather than a client-shaped echo; the instance-wide CLI
   * channel does not, and omits this.
   */
  accessField?: "workspaceApiAccess" | "workspaceMcpAccess";
}

/**
 * `TExtra` is whatever else the endpoint's GET returns alongside the credential state — the public
 * base URL, the available skills — exposed as `extra` so each caller keeps its own payload without
 * this hook knowing about any of them.
 */
export function useCredential<TExtra extends object = Record<string, never>>(
  endpoint: string,
  { feature }: Labels,
  { load = true, accessField }: CredentialOptions = {},
) {
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  // Named for what it is rather than "key": this is the transient plaintext, alive only between a
  // mint and the operator dismissing it, whereas hasKey is the durable fact that one exists. It also
  // keeps every component boundary clear of `key`, which React reserves for list identity.
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [extra, setExtra] = useState<TExtra | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const fail = (err: unknown, fallback: string) =>
    setFailure({
      ok: false,
      code: "NETWORK_ERROR",
      error: err instanceof Error ? err.message : fallback,
    });

  useEffect(() => {
    if (!load) return;
    // `active` drops a response that arrives after the endpoint changed or the component unmounted,
    // so a slow request for the previous workspace cannot overwrite the current one's state.
    let active = true;
    void (async () => {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) {
          setFailure(await readApiError(response, `Could not load ${feature}.`));
          return;
        }
        const body = (await response.json()) as CredentialSnapshot & TExtra;
        if (!active) return;
        setFailure(null);
        setEnabled(body.enabled);
        setHasKey(body.hasKey);
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
    setFailure(null);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) {
        setFailure(await readApiError(response, `Could not update ${feature}.`));
        return;
      }
      // The toggle moves one axis and never produces a credential, so there is nothing to reveal
      // here — only the server's confirmed flag to adopt in place of the value we assumed.
      const values = await confirmedValues(response);
      setEnabled((accessField ? values[accessField] : undefined) ?? next);
    } catch (err) {
      fail(err, `Could not update ${feature}.`);
    } finally {
      setBusy(false);
    }
  }, [enabled, endpoint, feature, accessField]);

  /**
   * Re-reads the channel after a conflict. A 409 means the credential existed or was missing contrary
   * to what this client last saw — another tab, the CLI or another operator moved it. Adopting the
   * server's state turns that into a corrected panel, where the button that does apply is the one now
   * on screen, instead of a button that keeps failing.
   */
  const resync = useCallback(async () => {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) return;
      const body = (await response.json()) as CredentialSnapshot & TExtra;
      setEnabled(body.enabled);
      setHasKey(body.hasKey);
      setExtra(body as unknown as TExtra);
    } catch {
      // Best effort. The conflict message already stands on its own; a failed refresh must not
      // replace it with a less specific network error.
    }
  }, [endpoint]);

  /** The returned plaintext is the only time the credential exists outside the server. */
  const issue = useCallback(
    async (operation: "generate" | "rotate") => {
      setBusy(true);
      setFailure(null);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation }),
        });
        if (!response.ok) {
          setFailure(await readApiError(response, `Could not ${operation} the key.`));
          if (response.status === 409) await resync();
          return;
        }
        const { plain } = (await response.json()) as { plain?: unknown };
        if (typeof plain !== "string" || !plain) throw new Error("The server returned an invalid key.");
        setPlaintext(plain);
        setHasKey(true);
        // Deliberately does not touch `enabled`: issuing a credential is the other axis, and a key
        // may legitimately be issued while the channel is still closed.
      } catch (err) {
        fail(err, `Could not ${operation} the key.`);
      } finally {
        setBusy(false);
      }
    },
    [endpoint, resync],
  );

  /** Issues a first credential. Fails if one already exists — rotate that one instead. */
  const generate = useCallback(() => issue("generate"), [issue]);

  /** Replaces the existing credential, invalidating the previous one. Fails if there is none. */
  const rotate = useCallback(() => issue("rotate"), [issue]);

  const revoke = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      if (!response.ok) {
        setFailure(await readApiError(response, "Could not revoke the key."));
        return;
      }
      setHasKey(false);
      setPlaintext(null);
    } catch (err) {
      fail(err, "Could not revoke the key.");
    } finally {
      setBusy(false);
    }
  }, [endpoint]);

  /** Hides the revealed plaintext. It is not recoverable afterwards — only rotation shows a new one. */
  const dismissPlaintext = useCallback(() => setPlaintext(null), []);

  return {
    enabled,
    hasKey,
    plaintext,
    extra,
    busy,
    error: failure?.error ?? null,
    failure,
    toggle,
    generate,
    rotate,
    revoke,
    dismissPlaintext,
  };
}
