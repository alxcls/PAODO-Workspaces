"use client";

import { useDelayedSet } from "./useDelayedSet";

const EMPTY = new Set<string>();
const ACTIVE = new Set(["active"]);

/** Shared threshold: how long a load must run before its spinner is worth showing. */
export const SPINNER_DELAY_MS = 300;

/** True only once `active` has stayed true past delayMs, so brief flags never flash on screen. */
export function useDelayed(active: boolean, delayMs: number): boolean {
  return useDelayedSet(active ? ACTIVE : EMPTY, delayMs).size > 0;
}
