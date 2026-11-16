import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activate,
  createReevaluateState,
  type DynamicRefusal,
  indexFile,
  type PerFileSources,
  promoteLearned,
  type ReevaluateState,
  settlePerFile,
} from './reevaluate.ts'

/** A node_modules file of package `name`. */
function nm(name: string, file = 'index.js'): string {
  return `/r/node_modules/${name}/${file}`
}

const evaluable = (path: string): boolean => !path.endsWith('.node')
const SOURCES: PerFileSources = { claimed: [], loaded: new Map(), keep: evaluable }

type Edges = readonly (readonly [string, readonly string[]])[]

/** Indexes `edges` (importer, targets) into `state`'s graph, in order. */
function index(
  state: ReevaluateState,
  edges: Edges,
  dynamic: ReadonlyMap<string, readonly string[]> = new Map(),
  elsewhere: ReadonlySet<string> = new Set(),
): void {
  for (const [importer, targets] of edges) {
    const bound = dynamic.get(importer)
    indexFile(
      state.perFile,
      importer,
      targets,
      bound === undefined ? null : new Set(bound),
      elsewhere.has(importer),
      evaluable,
    )
  }
}

/** Seeds `seeds`, settles the set, and returns it (members then pending) by package name. */
function settle(state: ReevaluateState, seeds: readonly string[]): DynamicRefusal[] {
  activate(state, seeds)
  const first = seeds[0] ?? nm('none')
  return [...settlePerFile(state, SOURCES, () => {}, first)]
}

function names(paths: Iterable<string>): string[] {
  return [...paths].map((path) => path.slice('/r/node_modules/'.length)).toSorted()
}

/** The set after seeding `plugin` over `edges`. */
function setOf(edges: Edges): string[] {
  const state = createReevaluateState()
  index(state, edges)
  settle(state, [nm('plugin')])
  return names(state.perFile.members)
}

test('settlePerFile: downward through a chain that only per-file packages import', () => {
  assert.deepEqual(
    setOf([
      [nm('plugin'), [nm('barrel')]],
      [nm('barrel'), [nm('registry')]],
      [nm('registry'), [nm('registry-dep')]],
    ]),
    ['barrel/index.js', 'plugin/index.js', 'registry-dep/index.js', 'registry/index.js'],
  )
})

test('settlePerFile: a dependency a shared package imports stays shared, and so does what it imports', () => {
  assert.deepEqual(
    setOf([
      [nm('plugin'), [nm('core')]],
      [nm('widget'), [nm('core')]],
      [nm('core'), [nm('core-dep')]],
    ]),
    ['plugin/index.js'],
  )
})

test('settlePerFile: what imports a member is a member, and keeps a dependency of both per file', () => {
  assert.deepEqual(
    setOf([
      [nm('library'), [nm('plugin'), nm('registry')]],
      [nm('plugin'), [nm('registry')]],
    ]),
    ['library/index.js', 'plugin/index.js', 'registry/index.js'],
  )
})

test('settlePerFile: a cycle below a per-file package joins whole', () => {
  assert.deepEqual(
    setOf([
      [nm('plugin'), [nm('reg')]],
      [nm('reg'), [nm('reg', 'a.js')]],
      [nm('reg', 'a.js'), [nm('reg')]],
    ]),
    ['plugin/index.js', 'reg/a.js', 'reg/index.js'],
  )
})

test('settlePerFile: a barrel the registry imports back joins with it', () => {
  assert.deepEqual(
    setOf([
      [nm('plugin'), [nm('barrel')]],
      [nm('barrel'), [nm('reg')]],
      [nm('reg'), [nm('barrel')]],
    ]),
    ['barrel/index.js', 'plugin/index.js', 'reg/index.js'],
  )
})

test('settlePerFile: a cycle a shared package also reaches stays shared', () => {
  assert.deepEqual(
    setOf([
      [nm('plugin'), [nm('reg')]],
      [nm('reg'), [nm('reg', 'a.js')]],
      [nm('reg', 'a.js'), [nm('reg')]],
      [nm('widget'), [nm('reg', 'a.js')]],
    ]),
    ['plugin/index.js'],
  )
})

test('settlePerFile: the set does not depend on the order the edges were indexed in', () => {
  const edges: Edges = [
    [nm('plugin'), [nm('barrel'), nm('dom')]],
    [nm('barrel'), [nm('reg')]],
    [nm('reg'), [nm('reg', 'a.js'), nm('barrel')]],
    [nm('reg', 'a.js'), [nm('reg'), nm('leaf')]],
    [nm('widget'), [nm('leaf')]],
  ]
  // `dom` only the plugin imports; `leaf` a shared package imports too.
  const expected = [
    'barrel/index.js',
    'dom/index.js',
    'plugin/index.js',
    'reg/a.js',
    'reg/index.js',
  ]
  for (const order of [
    edges,
    [...edges].reverse(),
    [edges[3], edges[0], edges[4], edges[2], edges[1]],
  ]) {
    const state = createReevaluateState()
    index(
      state,
      order.filter((edge) => edge !== undefined),
    )
    settle(state, [nm('plugin')])
    assert.deepEqual(names(state.perFile.members), expected)
  }
  // Edges indexed after the seed settle to the same set.
  const late = createReevaluateState()
  settle(late, [nm('plugin')])
  index(late, edges)
  settlePerFile(late, SOURCES, () => {}, nm('plugin'))
  assert.deepEqual(names(late.perFile.members), expected)
})

test('settlePerFile: an addon is never per file', () => {
  assert.deepEqual(setOf([[nm('plugin'), [nm('binding', 'binding.node')]]]), ['plugin/index.js'])
})

test('settlePerFile: a join after the file asked about an external is pending until the next file', () => {
  const state = createReevaluateState()
  index(state, [[nm('plugin'), []]])
  settle(state, [nm('plugin')])
  state.perFile.answered = true
  // `q` reaches the member `plugin`, so it is a member now; `x`, which only `q` imports, joins.
  index(state, [
    [nm('x'), [nm('d')]],
    [nm('q'), [nm('plugin'), nm('x')]],
  ])
  settlePerFile(state, SOURCES, () => {}, nm('q'))
  assert.deepEqual(names(state.perFile.members), ['plugin/index.js', 'q/index.js'])
  assert.deepEqual(names(state.perFile.pending), ['d/index.js', 'x/index.js'])
  // What imports a pending file is pending too; one that also imports a member is a member.
  index(state, [
    [nm('only-x'), [nm('x')]],
    [nm('both'), [nm('x'), nm('plugin')]],
  ])
  settlePerFile(state, SOURCES, () => {}, nm('both'))
  assert.ok(state.perFile.pending.has(nm('only-x')))
  assert.ok(state.perFile.members.has(nm('both')))
  promoteLearned(state)
  assert.equal(state.perFile.pending.size, 0)
  assert.equal(state.perFile.answered, false)
  assert.deepEqual(names(state.perFile.members), [
    'both/index.js',
    'd/index.js',
    'only-x/index.js',
    'plugin/index.js',
    'q/index.js',
    'x/index.js',
  ])
})

test('settlePerFile: an importer evaluated per file for another reason does not block a join', () => {
  const state = createReevaluateState()
  index(
    state,
    [
      [nm('plugin'), [nm('reg')]],
      [nm('served-user'), [nm('reg')]],
    ],
    new Map(),
    new Set([nm('served-user')]),
  )
  settle(state, [nm('plugin')])
  // The served importer then reaches a member, so it is one too (it is inlined either way).
  assert.deepEqual(names(state.perFile.members), [
    'plugin/index.js',
    'reg/index.js',
    'served-user/index.js',
  ])
})

test('settlePerFile: a user module between a member and a dependency joins when only members load it', () => {
  const state = createReevaluateState()
  index(state, [
    [nm('plugin'), ['/r/workspace/lib/index.js']],
    ['/r/workspace/lib/index.js', [nm('reg')]],
  ])
  settle(state, [nm('plugin')])
  assert.ok(state.perFile.members.has(nm('reg')))
  const shared = createReevaluateState()
  index(shared, [
    [nm('plugin'), ['/r/workspace/lib/index.js']],
    [nm('widget'), ['/r/workspace/lib/index.js']],
    ['/r/workspace/lib/index.js', [nm('reg')]],
  ])
  settle(shared, [nm('plugin')])
  assert.deepEqual(names(shared.perFile.members), ['plugin/index.js'])
})

test('settlePerFile: a dynamic file outside the set keeps what it could load shared, and says so', () => {
  const state = createReevaluateState()
  index(
    state,
    [
      [nm('plugin'), [nm('reg')]],
      [nm('loads-by-name'), []],
    ],
    new Map([[nm('loads-by-name'), ['loads-by-name', 'reg']]]),
  )
  const refusals = settle(state, [nm('plugin')])
  assert.deepEqual(names(state.perFile.members), ['plugin/index.js'])
  assert.deepEqual(refusals, [{ target: nm('reg'), dynamic: nm('loads-by-name') }])
  // Once the dynamic file is in the set, it loads through the registry: the join goes ahead.
  index(state, [[nm('uses-plugin'), [nm('plugin'), nm('loads-by-name')]]])
  activate(state, [nm('loads-by-name')])
  settlePerFile(state, SOURCES, () => {}, nm('uses-plugin'))
  assert.ok(state.perFile.members.has(nm('reg')))
})

test('settlePerFile: an edge between two files outside the set probes nothing', () => {
  const state = createReevaluateState()
  index(state, [[nm('plugin'), [nm('hub')]]])
  settle(state, [nm('plugin')])
  index(state, [[nm('a'), [nm('b')]]])
  assert.equal(state.perFile.probes.size, 0)
  // A shared importer of a member's dependency only bumps a count: the hub stays out, unprobed.
  index(state, [[nm('shared'), [nm('hub2')]]])
  index(state, [[nm('plugin2'), [nm('hub2')]]])
  assert.equal(state.perFile.probes.size, 0)
})
