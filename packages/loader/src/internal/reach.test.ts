// The early-stop reach walk (`cachedReach` in `inline.ts`, through `claimedReach`): it ends at the
// first edge to a target, however deep, without visiting the rest of the closure; a negative
// verdict kept from an earlier walk leaves out only the file it was kept for, never another path
// to a target; and a positive verdict is kept, for its file and for a walk that meets it.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { claimedReach, createInlineState, type InlineState } from './inline.ts'
import { loaderOptionsFor, writeTree } from './test-support.ts'

/** A CommonJS package `name` whose `index.js` requires `deps`, in that order. */
function pkg(name: string, deps: readonly string[]): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: `{"name":"${name}","main":"index.js"}\n`,
    [`node_modules/${name}/index.js`]: `${deps.map((dep) => `require('${dep}')`).join('\n')}\n`,
  }
}

function indexOf(root: string, name: string): string {
  return join(root, 'node_modules', name, 'index.js')
}

/** Whether the graph holds `name`'s entry: the walk visited (and so scanned) it. */
function visited(state: InlineState, root: string, name: string): boolean {
  return state.graph?.has(indexOf(root, name)) === true
}

const noUserEdges = (): [] => []

test('a target at depth 3 ends the walk, and a branch walked after it is never visited', () => {
  const big = Array.from({ length: 20 }, (_, index) => `big${index}`)
  const root = writeTree({
    // The walk takes the last edge first, so `b` is walked before `big0` and its fan-out.
    ...pkg('a', ['big0', 'b']),
    ...pkg('b', ['c']),
    ...pkg('c', ['target']),
    ...pkg('target', []),
    ...Object.assign({}, ...big.map((name, index) => pkg(name, big.slice(index + 1)))),
  })
  const state = createInlineState()
  const target = indexOf(root, 'target')
  const options = loaderOptionsFor(root)
  assert.equal(
    claimedReach(state, options, indexOf(root, 'a'), (path) => path === target, noUserEdges),
    true,
  )
  for (const name of ['a', 'b', 'c']) assert.ok(visited(state, root, name), name)
  for (const name of big) assert.equal(visited(state, root, name), false, name)
  // Only the start's verdict is kept on a hit: the files on the way were not decided.
  assert.equal(state.claimed.get(indexOf(root, 'a')), true)
  assert.equal(state.claimed.has(indexOf(root, 'b')), false)
})

test('a kept negative leaves out its own file only: another path to a target is still found', () => {
  const root = writeTree({
    ...pkg('x', ['w']),
    ...pkg('w', []),
    // `y` reaches the negative `x`, and the target through `z`; `x` is walked first (last edge).
    ...pkg('y', ['z', 'x']),
    ...pkg('z', ['w', 'target']),
    ...pkg('target', []),
  })
  const state = createInlineState()
  const target = indexOf(root, 'target')
  const claimed = (path: string): boolean => path === target
  const options = loaderOptionsFor(root)
  assert.equal(claimedReach(state, options, indexOf(root, 'x'), claimed, noUserEdges), false)
  assert.equal(state.claimed.get(indexOf(root, 'w')), false, 'a negative for every file walked')
  assert.equal(claimedReach(state, options, indexOf(root, 'y'), claimed, noUserEdges), true)
  // A file that becomes a target clears the verdicts (as the loader does): the negative goes.
  state.claimed.clear()
  const nowW = (path: string): boolean => path === indexOf(root, 'w')
  assert.equal(claimedReach(state, options, indexOf(root, 'x'), nowW, noUserEdges), true)
})

test('a positive is kept for its file, and ends a later walk that meets it', () => {
  const root = writeTree({
    ...pkg('p', ['q']),
    ...pkg('q', ['hit']),
    ...pkg('hit', []),
    ...pkg('outer', ['other', 'p']),
    ...pkg('other', []),
  })
  const state = createInlineState()
  const hit = indexOf(root, 'hit')
  const options = loaderOptionsFor(root)
  assert.equal(
    claimedReach(state, options, indexOf(root, 'p'), (path) => path === hit, noUserEdges),
    true,
  )
  // Nothing is a target now; the kept verdicts answer without a walk below `p`.
  const nothing = (): boolean => false
  assert.equal(claimedReach(state, options, indexOf(root, 'p'), nothing, noUserEdges), true)
  assert.equal(claimedReach(state, options, indexOf(root, 'outer'), nothing, noUserEdges), true)
  assert.equal(state.claimed.get(indexOf(root, 'outer')), true)
  // `outer` took `p`'s verdict as it met it, before its other edge.
  assert.equal(visited(state, root, 'other'), false)
})
