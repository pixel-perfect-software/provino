// `jestSnapshotStateView` (B23e, D128): Jest's `this.snapshotState` fields over Provino's state.
// Every field it carries is one jest-snapshot 30.5.2's own `SnapshotState` has, of the same kind
// (real jest-snapshot, reached through jest-config's install as the resolver's oracle is), and a
// read or write through it is a read or write of the state underneath. jest-image-snapshot's own
// use of it, through lodash `merge`, is `provino`'s `ecosystem-image-snapshot.test.ts`.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { SnapshotContextSource } from '@provino/types'
import { jestPolicy } from '../dialect.ts'
import { jestSnapshotStateView } from './snapshot-state-view.ts'

const fromJestConfig = createRequire(createRequire(import.meta.url).resolve('jest-config'))
const jestSnapshot = createRequire(fromJestConfig.resolve('jest-circus'))('jest-snapshot') as {
  SnapshotState: new (
    snapshotPath: string,
    options: { updateSnapshot: 'all' | 'new' | 'none'; snapshotFormat: object; rootDir: string },
  ) => object
}

const dir = mkdtempSync(join(tmpdir(), 'provino-snapshot-view-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** A state with nothing behind it but its fields. */
function source(update: SnapshotContextSource['update'] = 'new'): SnapshotContextSource {
  return { added: 0, matched: 0, unmatched: 0, updated: 0, update, liveCounters: new Map() }
}

/** What kind of value a field holds, as far as a matcher reading it can tell. */
const kindOf = (value: unknown): string => (value instanceof Map ? 'Map' : typeof value)

describe('jestSnapshotStateView', () => {
  test('each field is one jest-snapshot`s SnapshotState has, holding the same kind of value', () => {
    for (const update of ['all', 'new', 'none'] as const) {
      const jest = new jestSnapshot.SnapshotState(join(dir, `${update}.snap`), {
        updateSnapshot: update,
        snapshotFormat: {},
        rootDir: dir,
      })
      const view = jestSnapshotStateView(source(update))
      for (const field of Object.keys(view)) {
        assert.ok(Object.hasOwn(jest, field), `jest-snapshot's state has no ${field}`)
        assert.equal(
          kindOf(Reflect.get(view, field)),
          kindOf(Reflect.get(jest, field)),
          `${field} (${update})`,
        )
      }
      assert.equal(view._updateSnapshot, Reflect.get(jest, '_updateSnapshot'))
    }
  })

  test('_counters is the state`s live map, so a count set through it numbers the next key', () => {
    const state = source()
    const view = jestSnapshotStateView(state)
    assert.equal(view._counters, state.liveCounters)
    view._counters.set('t', 2)
    assert.equal(state.liveCounters.get('t'), 2)
    state.liveCounters.set('u', 1)
    assert.equal(view._counters.get('u'), 1)
  })

  test('the four counts read and write the state`s own', () => {
    const state = source()
    const view = jestSnapshotStateView(state)
    // As jest-image-snapshot writes them: `merge(snapshotState, { added: snapshotState.added + 1 })`.
    Object.assign(view, { added: view.added + 1 })
    view.updated += 2
    view.matched += 3
    view.unmatched += 4
    assert.deepEqual([state.added, state.updated, state.matched, state.unmatched], [1, 2, 3, 4])
    state.added = 10
    assert.equal(view.added, 10)
  })

  test('_counters and _updateSnapshot can`t be replaced', () => {
    const state = source('none')
    const view = jestSnapshotStateView(state)
    assert.equal(Reflect.set(view, '_counters', new Map()), false)
    assert.equal(Reflect.set(view, '_updateSnapshot', 'all'), false)
    assert.equal(view._counters, state.liveCounters)
    assert.equal(view._updateSnapshot, 'none')
  })

  test('the policy`s contextView ref loads it', async () => {
    const ref = resolvePolicy(jestPolicy).snapshot.contextView
    assert.ok(ref !== null)
    assert.equal(await createBehaviourLoader().load(ref), jestSnapshotStateView)
  })
})
