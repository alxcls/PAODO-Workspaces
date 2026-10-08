/** Cache reads are a subset of provider-reported total input, so only uncached input is derived. */
export function uncachedInputTokens(inputTokensTotal: number, inputTokensCacheRead: number): number {
  return Math.max(0, inputTokensTotal - inputTokensCacheRead);
}
