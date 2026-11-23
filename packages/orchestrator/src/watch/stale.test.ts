// What a warm worker is told after a change, and which changes replace the workers instead.
import assert from 'node:assert/strict'
import type { WorkerKey } from '@provino/types'
import { test } from 'provino'
import { workerKeyOf } from '../key.ts'
import type { WatchEvent } from './coalesce.ts'
import { createStaleModules, retirementFor } from './stale.ts'

test('each live worker gets every change once, with its next file, and a new worker none from before', () => {
  const stale = createStaleModules()
  stale.register(1)
  stale.changed(['/p/b.ts', '/p/a.ts'])
  stale.register(2)
  stale.changed(['/p/c.ts', '/p/a.ts'])
  assert.deepEqual(stale.take(1), ['/p/a.ts', '/p/b.ts', '/p/c.ts'], 'sorted, each once')
  assert.deepEqual(stale.take(1), [], 'told once')
  assert.deepEqual(stale.take(2), ['/p/a.ts', '/p/c.ts'], 'only what came after it started')
  assert.deepEqual(stale.take(3), [], 'a worker it never saw')
  stale.forget(2)
  stale.changed(['/p/d.ts'])
  assert.equal(stale.size(), 1)
  assert.deepEqual(stale.take(2), [])
  assert.deepEqual(stale.take(1), ['/p/d.ts'])
})

const key = (isolation: WorkerKey['isolation']): WorkerKey =>
  workerKeyOf({
    project: 'p',
    pool: 'forks',
    isolation,
    environment: 'node',
    environmentOptions: {},
    execArgv: [],
  })

const event = (kind: WatchEvent['kind'], path: string): WatchEvent => ({
  kind,
  path,
  mtimeMs: kind === 'unlink' ? undefined : 1,
})

test('an add, an unlink or a package.json retires every worker; any change retires the tier none ones', () => {
  const registry = key('registry')
  const none = key('none')
  for (const batch of [
    [event('change', '/p/a.ts'), event('add', '/p/b.ts')],
    [event('unlink', '/p/a.ts')],
    [event('change', '/p/package.json')],
  ]) {
    const which = retirementFor(batch)
    assert.equal(which?.(registry), true)
    assert.equal(which?.(none), true)
  }
  const which = retirementFor([event('change', '/p/a.ts')])
  assert.equal(which?.(registry), false, 'a plain edit is told, not retired')
  assert.equal(which?.(none), true, 'a worker that shares instances is replaced')
  assert.equal(retirementFor([]), undefined)
})
