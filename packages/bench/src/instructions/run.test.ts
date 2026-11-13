import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BenchError } from '../errors.ts'
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { PACKAGE_DIR } from '../suites.ts'
import { childEnv, readWorkload, runCounted, runPlain, stripTypesArgs, V8_FLAGS } from './run.ts'

const fromSource = { nodeArgs: ['--conditions=provino-source'] }
// The child's environment has no NODE_OPTIONS, so below 22.18 the stand-in needs the flag too.
const standIn = [
  process.execPath,
  ...stripTypesArgs(),
  fileURLToPath(new URL('fixtures/stand-in-valgrind.ts', import.meta.url)),
]

test('the V8 flags are the ones Track 12 F7 measured a 0.05% spread with, and no GC task', () => {
  // The last one is why loader-e2e repeats; determinism.test.ts shows what it changes.
  assert.deepEqual(V8_FLAGS, [
    '--single-threaded',
    '--no-opt',
    '--predictable',
    '--no-incremental-marking-task',
  ])
})

test('Node below 22.18 is told to strip types; 22.18 and later strip them by default', () => {
  assert.deepEqual(stripTypesArgs('v22.15.0'), ['--experimental-strip-types'])
  assert.deepEqual(stripTypesArgs('v22.18.0'), [])
  assert.deepEqual(stripTypesArgs('v24.22.1'), [])
  assert.deepEqual(stripTypesArgs('v26.1.0'), [])
})

test('the child sees a fixed environment: no compile cache, no colour, UTC, and no caller noise', () => {
  const env = childEnv({ PATH: '/bin', HOME: '/h', NODE_OPTIONS: '--inspect', FORCE_COLOR: '1' })
  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/h',
    NODE_DISABLE_COMPILE_CACHE: '1',
    NO_COLOR: '1',
    TZ: 'UTC',
    LANG: 'C',
  })
})

test('a sample line is read; anything else on the output is not', () => {
  const sample = { ok: true, ms: 1.5, units: 3, detail: 'x' }
  assert.deepEqual(
    readWorkload(
      `warning\n${SAMPLE_PREFIX}{"ok":"yes"}\n${SAMPLE_PREFIX}${JSON.stringify(sample)}\n`,
    ),
    sample,
  )
  assert.equal(readWorkload('{"ok":true,"ms":1,"units":1,"detail":""}'), undefined)
})

test('a plain run of a leg returns its sample', async () => {
  const sample = await runPlain('hoist', '/nonexistent', PACKAGE_DIR, fromSource)
  assert.equal(sample.ok, true)
  assert.equal(sample.units, 60)
})

test('a counted run reads the output file valgrind wrote, and a plant adds work', async () => {
  const seams = { ...fromSource, valgrind: standIn }
  const plain = await runCounted('hoist', '/nonexistent', PACKAGE_DIR, 0, seams)
  assert.equal(plain.sample.ok, true)
  assert.ok(plain.instructions > 0)
  const planted = await runCounted('hoist', '/nonexistent', PACKAGE_DIR, 1000, seams)
  // The stand-in counts printed bytes; the planted run prints its iterations in the detail.
  assert.ok(planted.instructions > plain.instructions)
  assert.match(planted.sample.detail, /planted 1000 iterations/)
})

test('an unknown leg fails with the child’s output, not a count', async () => {
  await assert.rejects(
    runCounted('no-such-leg', '/nonexistent', PACKAGE_DIR, 0, { ...fromSource, valgrind: standIn }),
    (error: unknown) =>
      error instanceof BenchError &&
      error.code === 'BENCH_LEG_FAILED' &&
      /usage: child\.ts/.test(error.message),
  )
})
