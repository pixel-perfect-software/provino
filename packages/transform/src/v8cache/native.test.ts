// T3.7: `enableNativeCompileCache`. Node's compile cache is process-global, so every call that
// reaches Node runs in a fresh child (`runChild`), with Node's own environment switches removed.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { hasProvinoTag } from '../cache/store.ts'
import { enableNativeCompileCache } from './index.ts'
import { compileCacheArgumentForm } from './native.ts'
import { runChild, tempDir } from './test-helpers.ts'

const dirs: (() => void)[] = []
after(() => {
  for (const remove of dirs) remove()
})
function scratch(): string {
  const { dir, remove } = tempDir()
  dirs.push(remove)
  return dir
}

interface Result {
  readonly status: string
  readonly directory?: string
  readonly message?: string
}
interface Outcome {
  readonly first: Result
  readonly second: Result
  readonly calls: readonly string[]
}
/** No inherited `NODE_COMPILE_CACHE` or `NODE_DISABLE_COMPILE_CACHE`: the child starts with the cache off. */
const CLEAN = { NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: undefined }
function native(
  scenario: object,
  env: Readonly<Record<string, string | undefined>> = CLEAN,
): Outcome {
  return runChild('native', scenario, { env }) as Outcome
}

test('the argument form: a string before Node 24.12, the object from 24.12 and from 25', () => {
  const forms: readonly (readonly [string, 'string' | 'object'])[] = [
    ['22.15.0', 'string'],
    ['22.23.0', 'string'],
    ['24.11.9', 'string'],
    ['24.12.0', 'object'],
    ['24.22.1', 'object'],
    ['25.0.0', 'object'],
    ['26.1.0', 'object'],
    ['v22.15.0', 'string'],
    ['not a version', 'string'],
  ]
  for (const [version, form] of forms) {
    assert.equal(compileCacheArgumentForm(version), form, version)
  }
})

test("mode 'off' is 'disabled' without calling Node: the directory isn't made", () => {
  const dir = join(scratch(), 'off')
  assert.deepEqual(enableNativeCompileCache(dir, 'off'), { status: 'disabled' })
  assert.equal(existsSync(dir), false)
  // In a child, where Node's own function would show up if it were called.
  const { first, second } = native({ dir, mode: 'off' })
  assert.deepEqual(first, { status: 'disabled' })
  assert.deepEqual(second, { status: 'disabled' })
  assert.equal(existsSync(dir), false)
})

test('the first call enables Node’s compile cache and tags the directory, the second finds it enabled', () => {
  const dir = join(scratch(), 'native')
  const { first, second } = native({ dir })
  assert.equal(first.status, 'enabled')
  assert.equal(typeof first.directory, 'string')
  assert.ok(existsSync(dir))
  assert.ok(existsSync(join(dir, 'CACHEDIR.TAG')))
  assert.ok(hasProvinoTag(dir))
  assert.equal(second.status, 'already-enabled')
})

test('Node’s own switch is respected: NODE_DISABLE_COMPILE_CACHE gives disabled', () => {
  const dir = join(scratch(), 'disabled-by-env')
  const { first } = native({ dir }, { ...CLEAN, NODE_DISABLE_COMPILE_CACHE: '1' })
  assert.equal(first.status, 'disabled')
  assert.equal(existsSync(join(dir, 'CACHEDIR.TAG')), false)
})

test('a Node with no enableCompileCache is unsupported', () => {
  const { first } = native({ dir: join(scratch(), 'x'), fake: 'missing' })
  assert.deepEqual(first, { status: 'unsupported' })
})

test('a refusal is a result, never a throw: failed, with Node’s message', () => {
  const dir = join(scratch(), 'x')
  const threw = native({ dir, fake: 'throws' })
  assert.equal(threw.first.status, 'failed')
  assert.equal(threw.first.message, 'no cache for you')
  const failed = native({ dir, fake: 'failed' })
  assert.deepEqual(failed.first, { status: 'failed', message: 'cannot create it' })
  assert.equal(existsSync(join(dir, 'CACHEDIR.TAG')), false)
})

test('where the object form is tried and refused, the call falls back to the string form', () => {
  const dir = join(scratch(), 'fallback')
  const { first, calls } = native({ dir, fake: 'object-throws' })
  assert.equal(first.status, 'enabled')
  // The child calls twice, so each call's attempts are there twice.
  if (compileCacheArgumentForm(process.versions.node) === 'object') {
    assert.deepEqual(calls, ['object', 'string', 'object', 'string'])
  } else {
    assert.deepEqual(calls, ['string', 'string'])
  }
})
