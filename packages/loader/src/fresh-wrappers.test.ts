// A module evaluated in a registry of one file runs a fresh wrapper function every time, so no
// file's code shares V8 feedback with the next file's (a function's inline caches live in a cell
// every closure made by one enclosing function object shares, so one wrapper called in every file
// gives every file's copy of a function one feedback vector). A registry shared across files
// (`none`) evaluates a module once and calls the one wrapper the worker made. Either way the
// wrapper's script is compiled once per worker and mode, and the compile listeners (V8 coverage,
// source maps) hear of it once. `pnpm bench:loader megamorphic` shows what the shared feedback cost.
//
// A CommonJS wrapper is sloppy, so `arguments.callee` is the wrapper function itself. An ES
// module's is strict, so its tests count the runs of each `vm.Script` instead: the same script run
// again is a new function with no new compile.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Script } from 'node:vm'
import type { CompiledModuleEvent, Loader } from '@provino/types'
import { afterAll, test } from 'provino'
import { loaderOptionsFor } from './internal/test-support.ts'
import { createLoader } from './loader.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const FILES = {
  'wrapper.cjs': 'module.exports = { wrapper: arguments.callee }\n',
  'sync.ts': 'export const value: number = 1\n',
  // Top-level await: an `import` of it evaluates with the async wrapper.
  'async.ts': 'await Promise.resolve()\nexport const value: number = 2\n',
  // Names a scope binding, so its script makes an outer function that returns the wrapper.
  'scoped.ts': 'export const seen: string = typeof mocker\n',
  'a.test.ts': '',
  'b.test.ts': '',
}

function setup(): { root: string; loader: Loader; events: CompiledModuleEvent[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-fresh-wrappers-')))
  roots.push(root)
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const loader = createLoader(loaderOptionsFor(root, { moduleScope: { names: ['mocker'] } }))
  const events: CompiledModuleEvent[] = []
  loader.onModuleCompiled((event) => events.push(event))
  return { root, loader, events }
}

/** How often each module was reported compiled, by its file name. */
function reported(root: string, events: readonly CompiledModuleEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) {
    const name = event.scriptUrl.slice(root.length + 1)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

/** Counts the runs of each `vm.Script` from here on, for the rest of the test. */
function countRuns(): () => number[] {
  const original = Script.prototype.runInThisContext
  const scripts: unknown[] = []
  Script.prototype.runInThisContext = function (
    this: Script,
    ...args: Parameters<Script['runInThisContext']>
  ) {
    scripts.push(this)
    return original.apply(this, args)
  }
  return () => {
    Script.prototype.runInThisContext = original
    const byScript = new Map<unknown, number>()
    for (const script of scripts) byScript.set(script, (byScript.get(script) ?? 0) + 1)
    return [...byScript.values()]
  }
}

type Wrapper = { readonly wrapper: unknown }

test('registry: each evaluation of a module calls a new wrapper; the script is compiled and reported once', () => {
  const { root, loader, events } = setup()
  const path = join(root, 'wrapper.cjs')
  const a = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'registry' })
  const first = a.require<Wrapper>(path).wrapper
  assert.equal(typeof first, 'function')
  assert.equal(a.require<Wrapper>(path).wrapper, first, 'the file keeps its instance')
  const isolated = a.isolateModules(() => a.require<Wrapper>(path).wrapper)
  const b = loader.createFileRegistry(join(root, 'b.test.ts'), { tier: 'registry' })
  const second = b.require<Wrapper>(path).wrapper
  assert.notEqual(second, first, 'the next file’s evaluation calls a new wrapper')
  assert.notEqual(isolated, first, 'so does an isolateModules evaluation')
  assert.notEqual(second, isolated)
  assert.equal(String(second), String(first), 'of the same code')
  assert.deepEqual(reported(root, events), { 'wrapper.cjs': 1 })
})

test('none: the shared registry calls the one wrapper again; the script is compiled and reported once', () => {
  const { root, loader, events } = setup()
  const path = join(root, 'wrapper.cjs')
  const a = loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'none' })
  const first = a.require<Wrapper>(path).wrapper
  a.resetModules()
  const afterReset = a.require<Wrapper>(path).wrapper
  const b = loader.createFileRegistry(join(root, 'b.test.ts'), { tier: 'none' })
  b.resetModules()
  const next = b.require<Wrapper>(path).wrapper
  assert.equal(afterReset, first, 'evaluated again after resetModules, through the same wrapper')
  assert.equal(next, first, 'and in the next file')
  assert.deepEqual(reported(root, events), { 'wrapper.cjs': 1 })
})

for (const tier of ['registry', 'none'] as const) {
  const runs = tier === 'registry' ? 'runs each script once per file' : 'runs each script once'
  test(`${tier}: an ES module's sync, async and scoped wrappers: each script compiled and reported once, and ${runs}`, async () => {
    const { root, loader, events } = setup()
    const runsByScript = countRuns()
    for (const name of ['a.test.ts', 'b.test.ts']) {
      const registry = loader.createFileRegistry(join(root, name), { tier })
      assert.equal(registry.require<{ value: number }>(join(root, 'sync.ts')).value, 1)
      assert.equal((await registry.import<{ value: number }>(join(root, 'async.ts'))).value, 2)
      assert.equal(registry.require<{ seen: string }>(join(root, 'scoped.ts')).seen, 'undefined')
    }
    // Three scripts (sync.ts's plain wrapper, async.ts's async one, scoped.ts's outer function),
    // each run once per evaluation: twice in a registry per file, once in the shared one.
    assert.deepEqual(runsByScript(), tier === 'registry' ? [2, 2, 2] : [1, 1, 1])
    assert.deepEqual(reported(root, events), { 'sync.ts': 1, 'async.ts': 1, 'scoped.ts': 1 })
  })
}
