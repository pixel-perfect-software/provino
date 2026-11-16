import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createReevaluateState,
  joinsPerFile,
  linkPerFile,
  type PerFileGraph,
  selectPerFile,
} from './reevaluate.ts'

/** A per-file graph with `edges` (importer, target) known. */
function graphOf(edges: readonly (readonly [string, string])[]): PerFileGraph {
  const graph = createReevaluateState().perFile
  for (const [importer, target] of edges) linkPerFile(graph, importer, target)
  return graph
}

const evaluable = (path: string): boolean => !path.endsWith('.node')

test('joinsPerFile: a dependency joins only when every known importer is per file', () => {
  assert.equal(joinsPerFile(new Set(['a', 'b']), new Set(['a', 'b', 'c'])), true)
  assert.equal(joinsPerFile(new Set(['a', 'shared']), new Set(['a'])), false)
})

test('selectPerFile: downward through a chain that only per-file packages import', () => {
  const graph = graphOf([
    ['plugin', 'barrel'],
    ['barrel', 'registry'],
    ['registry', 'registry-dep'],
  ])
  assert.deepEqual([...selectPerFile(graph, ['plugin'], evaluable)].toSorted(), [
    'barrel',
    'plugin',
    'registry',
    'registry-dep',
  ])
})

test('selectPerFile: a dependency a shared package imports stays shared, and so does what it imports', () => {
  const graph = graphOf([
    ['plugin', 'core'],
    ['widget', 'core'],
    ['core', 'core-dep'],
  ])
  assert.deepEqual([...selectPerFile(graph, ['plugin'], evaluable)], ['plugin'])
})

test('selectPerFile: what imports a per-file package is per file, also after a downward join', () => {
  const graph = graphOf([
    ['library', 'plugin'],
    ['plugin', 'registry'],
    ['library', 'registry'],
    ['late', 'registry'],
  ])
  // `late` reaches the registry, which is per file once `plugin` and `library` are: it is
  // inlined by the reach rule when `registry` is already a member (`base`).
  assert.deepEqual(
    [...selectPerFile(graph, ['plugin'], evaluable)].toSorted(),
    ['library', 'plugin'],
    'without the base, late is a shared importer and the registry stays shared',
  )
  assert.deepEqual([...selectPerFile(graph, ['plugin'], evaluable, ['registry'])].toSorted(), [
    'late',
    'library',
    'plugin',
    'registry',
  ])
})

test('selectPerFile: an addon is never per file', () => {
  const graph = graphOf([['plugin', 'binding.node']])
  assert.deepEqual([...selectPerFile(graph, ['plugin'], evaluable)], ['plugin'])
})
