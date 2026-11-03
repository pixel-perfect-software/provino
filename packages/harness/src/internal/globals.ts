// The corpus runners put the test API on `globalThis` for one file's run and take it off again.

/**
 * Assigns each of `values` as a global and returns the function that puts back what was there
 * before: the saved value, or no property at all when the name had none.
 * @internal
 */
export function installGlobals(values: Readonly<Record<string, unknown>>): () => void {
  const scope = globalThis as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, scope[name])
    scope[name] = value
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete scope[name]
      else scope[name] = value
    }
  }
}
