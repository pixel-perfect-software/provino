// T9.12: the inverse of the dependency graph. jest-resolve-dependencies' `resolveInverseModuleMap`
// (L105-169) returns the changed test files themselves and every test reachable backwards from a
// changed file. Jest scans every module once per level; this walks a reverse index (speed: the
// same set in O(edges)).

/** Dependents by dependency: for each file, the files that import it. */
export type ReverseGraph = ReadonlyMap<string, readonly string[]>

/** The reverse of `edges` (file to its dependencies). */
export function reverseOf(edges: ReadonlyMap<string, ReadonlySet<string>>): ReverseGraph {
  const reverse = new Map<string, string[]>()
  for (const [file, dependencies] of edges) {
    for (const dependency of dependencies) {
      const dependents = reverse.get(dependency)
      if (dependents === undefined) reverse.set(dependency, [file])
      else dependents.push(file)
    }
  }
  return reverse
}

/**
 * Every file `isTarget` accepts that is a seed or reaches one through the graph. The walk passes
 * through files `isTarget` rejects (a source imported by a source imported by a test).
 */
export function reachBackwards(
  seeds: Iterable<string>,
  reverse: ReverseGraph,
  isTarget: (file: string) => boolean,
): Set<string> {
  const result = new Set<string>()
  const visited = new Set<string>()
  const pending: string[] = []
  for (const seed of seeds) {
    if (visited.has(seed)) continue
    visited.add(seed)
    pending.push(seed)
    if (isTarget(seed)) result.add(seed)
  }
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const dependent of reverse.get(file) ?? []) {
      if (visited.has(dependent)) continue
      visited.add(dependent)
      pending.push(dependent)
      if (isTarget(dependent)) result.add(dependent)
    }
  }
  return result
}
