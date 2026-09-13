/** GET a URL and parse its JSON body, throwing errMsg on a non-ok response. Shaped for the fetchers
 *  passed to useAsyncResource: pass the request's abort signal, and any extra init (e.g. no-store). */
export async function fetchJson<T>(url: string, signal: AbortSignal, errMsg: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(errMsg);
  return (await response.json()) as T;
}
