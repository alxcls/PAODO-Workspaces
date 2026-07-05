// Cache a value on the Node global so it survives Next.js module re-instantiation. The custom server
// and the webpack-bundled API routes each load module code into their own scope, so a plain
// module-level `const` gives each of them a separate instance — a workspace registry created by the
// API would be invisible to the WS handler, an in-memory cache would diverge, etc. Holding the value
// on `global` under a stable key makes every module instance share the one instance.
//
// `init` runs exactly once, the first time any instance requests the key.
export function globalSingleton<T>(key: string, init: () => T): T {
  const g = global as typeof global & { __singletons?: Record<string, unknown> };
  g.__singletons ??= {};
  if (!(key in g.__singletons)) g.__singletons[key] = init();
  return g.__singletons[key] as T;
}
