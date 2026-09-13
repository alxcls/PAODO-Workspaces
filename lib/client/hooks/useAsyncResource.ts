"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface AsyncResource<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  reload: () => Promise<void>;
}

interface ResourceState<T> {
  fetcher: Fetcher<T>;
  data: T | null;
  loading: boolean;
  error: boolean;
}

/**
 * Pass a useCallback fetcher whose dependencies identify the resource. A changed fetcher hides
 * the old result immediately; reloading the same resource retains its data until the read finishes.
 * Reload is awaitable, and superseded/unmounted requests cannot update state.
 */
export function useAsyncResource<T>(
  fetcher: Fetcher<T>,
  { enabled = true, refreshKey }: { enabled?: boolean; refreshKey?: number } = {},
): AsyncResource<T> {
  const [state, setState] = useState<ResourceState<T> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      setState(null);
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((previous) => ({
      fetcher,
      data: previous?.fetcher === fetcher ? previous.data : null,
      loading: true,
      error: false,
    }));
    try {
      const data = await fetcher(controller.signal);
      if (!controller.signal.aborted) setState({ fetcher, data, loading: false, error: false });
    } catch {
      if (!controller.signal.aborted) {
        setState((previous) => ({
          fetcher,
          data: previous?.fetcher === fetcher ? previous.data : null,
          loading: false,
          error: true,
        }));
      }
    }
  }, [fetcher, enabled]);

  useEffect(() => {
    // This effect starts the external request and records its pending state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    return () => controllerRef.current?.abort();
  }, [reload, refreshKey]);

  if (!enabled) return { data: null, loading: false, error: false, reload };
  if (state?.fetcher !== fetcher) return { data: null, loading: true, error: false, reload };
  return { data: state.data, loading: state.loading, error: state.error, reload };
}
