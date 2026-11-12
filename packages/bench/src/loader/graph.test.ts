// The corpus of `bench:loader graph` (T2.6, B13d): the rebuilt corpus meets the research's floors,
// and the graph misses no static edge that `oxc-parser` finds. The timing bars are the command's.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCorpusGraph, checkEdges, corpusStats, FLOORS } from './graph.ts'

test('the corpus holds at least the research floors, and no static edge is missed', async () => {
  const graph = await buildCorpusGraph()
  const stats = corpusStats(graph)
  assert.ok(stats.files >= FLOORS.files, `${stats.files} files`)
  assert.ok(stats.bytes >= FLOORS.bytes, `${stats.bytes} bytes`)
  assert.ok(stats.edges >= FLOORS.edges, `${stats.edges} edges`)
  const check = checkEdges(graph)
  assert.deepEqual(check.missed, [])
  assert.equal(check.parseFailures, 0)
})
