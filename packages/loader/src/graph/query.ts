// Reverse queries over the graph (T2.6): who imports a file, directly or through others.
import type { ThirdPartyGraph } from './build.ts'

/**
 * Every file in the graph that can reach any of `targets` through its edges (a target is
 * included only if another target, or itself through a cycle, reaches it), in no particular order.
 * @public
 */
export function importersOf(
  graph: ThirdPartyGraph,
  targets: string | readonly string[],
): readonly string[] {
  const wanted = typeof targets === 'string' ? [targets] : targets
  const importers = new Map<string, string[]>()
  for (const path of graph.paths()) {
    for (const edge of graph.nodeOf(path)?.edges ?? []) {
      if (edge.target === null) continue
      const list = importers.get(edge.target)
      if (list === undefined) importers.set(edge.target, [path])
      else list.push(path)
    }
  }
  const found = new Set<string>()
  const stack = [...wanted]
  while (stack.length > 0) {
    const target = stack.pop()
    if (target === undefined) continue
    for (const importer of importers.get(target) ?? []) {
      if (found.has(importer)) continue
      found.add(importer)
      stack.push(importer)
    }
  }
  return [...found]
}
