// What the loader relies on (B13c): `decide`'s fast path, the root `__mocks__` index listed once,
// `mockFor` and `createMockFromModule` resolving from the caller, and automock's scratch load, with
// the mock values swapped for its synchronous part as Jest's `_generateMock` swaps its registries.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LoadActualOptions, ResolveContext, Resolver } from '@provino/types'
import { neutral } from '../internal/test-support.ts'
import { createMockRegistry } from '../registry.ts'
import { createRootMockIndex } from './manual-mocks.ts'
import { createModuleMockRegistry } from './registry.ts'
import { fakeResolver, jestLike, tempTree, vitestLike } from './test-support.ts'

/** A resolver that counts its calls, over `files`. */
function countingResolver(files: Readonly<Record<string, string>>): {
  readonly resolver: Resolver
  readonly calls: () => number
} {
  const inner = fakeResolver(files)
  let count = 0
  return {
    resolver: {
      ...inner,
      resolve(specifier: string, context: ResolveContext) {
        count++
        return inner.resolve(specifier, context)
      },
    },
    calls: () => count,
  }
}

test('decide returns before any lookup when nothing is registered, automock is off and there is no root mock', () => {
  const tree = tempTree('provino-fast-')
  let listed = 0
  const index = createRootMockIndex({ roots: [tree.dir], extensions: ['.ts'] })
  const counted = {
    find: (specifier: string) => index.find(specifier),
    isEmpty: () => {
      listed++
      return index.isEmpty()
    },
  }
  const { resolver, calls } = countingResolver({})
  const registry = createModuleMockRegistry({
    policy: jestLike,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver,
    roots: [tree.dir],
    extensions: ['.ts'],
    loadActual: () => assert.fail('nothing loads'),
    rootMocks: counted,
  })
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(registry.decide('/proj/a.ts', '/proj/t.ts', 'cjs', 'pkg'), { mocked: false })
  }
  assert.equal(calls(), 0, 'no resolve')
  assert.equal(listed, 3, 'only the index, which lists the trees once')
})

test('the root __mocks__ index lists each tree once, first root then first extension, nested names too', () => {
  const first = tempTree('provino-index-a-')
  const second = tempTree('provino-index-b-')
  first.write('__mocks__/pkg.js')
  first.write('__mocks__/pkg.ts')
  first.write('__mocks__/@scope/lib.ts')
  first.write('__mocks__/pkg/sub.ts')
  first.write('__mocks__/fs.ts')
  second.write('__mocks__/pkg.ts')
  second.write('__mocks__/only-second.ts')
  const index = createRootMockIndex({ roots: [first.dir, second.dir], extensions: ['.ts', 'js'] })
  assert.equal(index.isEmpty(), false)
  assert.equal(index.find('pkg')?.path, join(first.dir, '__mocks__', 'pkg.ts'))
  assert.equal(index.find('@scope/lib')?.path, join(first.dir, '__mocks__', '@scope', 'lib.ts'))
  assert.equal(index.find('pkg/sub')?.path, join(first.dir, '__mocks__', 'pkg', 'sub.ts'))
  assert.equal(
    index.find('node:fs')?.path,
    join(first.dir, '__mocks__', 'fs.ts'),
    'node: is the core name',
  )
  assert.equal(index.find('only-second')?.path, join(second.dir, '__mocks__', 'only-second.ts'))
  assert.equal(index.find('./pkg'), null, 'a relative specifier has no root mock')
  assert.equal(index.find('../pkg'), null)
  assert.equal(index.find('missing'), null)
  // Listed once: a file written later is not seen (there is no watch mode yet).
  first.write('__mocks__/later.ts')
  assert.equal(index.find('later'), null)
  assert.equal(
    createRootMockIndex({ roots: ['/no/such/dir'], extensions: ['.ts'] }).isEmpty(),
    true,
  )
})

test('mockFor serves the registered mock, else the manual mock, else an automock, from the caller', () => {
  const tree = tempTree('provino-mockfor-')
  const real = tree.write('src/real.ts')
  const registered = tree.write('src/registered.ts')
  const loads: string[] = []
  const registry = createModuleMockRegistry({
    policy: jestLike,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: fakeResolver({ './real': real, './registered': registered }),
    roots: [tree.dir],
    extensions: ['.ts'],
    loadActual: (id) => {
      loads.push(id)
      return { greet: () => 'real' }
    },
  })
  const auto = registry.mockFor('./real', join(tree.dir, 'src', 'a.test.ts')) as {
    greet: () => unknown
  }
  assert.equal(auto.greet(), undefined, 'an automock of the real module')
  assert.deepEqual(loads, [real])
  registry.register(
    './registered',
    { kind: 'factory', factory: () => ({ who: 'factory' }) },
    {
      from: join(tree.dir, 'src', 'a.test.ts'),
    },
  )
  assert.deepEqual(registry.mockFor('./registered', join(tree.dir, 'src', 'a.test.ts')), {
    who: 'factory',
  })
  // A package that isn't installed, with a root manual mock: the mock file is what is served.
  const manual = tree.write('__mocks__/ghost.ts')
  registry.mockFor('ghost', join(tree.dir, 'src', 'a.test.ts'))
  assert.equal(loads.at(-1), manual)
  assert.throws(() => registry.mockFor('./nowhere', join(tree.dir, 'a.ts')), {
    code: 'module-missing',
  })
})

test('createMockFromModule builds a fresh automock each time, from a scratch load', () => {
  const tree = tempTree('provino-create-')
  const real = tree.write('real.ts')
  const loads: Array<LoadActualOptions | undefined> = []
  const registry = createModuleMockRegistry({
    policy: jestLike,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: fakeResolver({ './real': real }),
    roots: [tree.dir],
    extensions: ['.ts'],
    loadActual: (_id, _importer, options) => {
      loads.push(options)
      return { f: () => 1 }
    },
  })
  const one = registry.createMockFromModule('./real', join(tree.dir, 'a.ts'))
  const two = registry.createMockFromModule('./real', join(tree.dir, 'a.ts'))
  assert.notEqual(one, two, 'not cached')
  assert.deepEqual(loads, [{ scratch: true }, { scratch: true }])
})

test('automock’s real load sees fresh mock values: a mocked dependency is built again inside, and dropped', () => {
  const tree = tempTree('provino-scratch-')
  const dep = tree.write('dep.ts')
  const auto = tree.write('auto.ts')
  let builds = 0
  let insideValue: unknown
  const registry = createModuleMockRegistry({
    policy: jestLike,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: fakeResolver({ './dep': dep, './auto': auto }),
    roots: [tree.dir],
    extensions: ['.ts'],
    loadActual: (id) => {
      // The real module imports its mocked dependency while it loads.
      if (id === auto) insideValue = registry.materialize(dep)
      return { f: () => 1 }
    },
  })
  const from = join(tree.dir, 't.ts')
  registry.register('./dep', { kind: 'factory', factory: () => ({ build: ++builds }) }, { from })
  registry.register('./auto', { kind: 'automock', spy: false }, { from })
  const outside = registry.materialize(dep)
  registry.materialize(auto)
  assert.deepEqual(outside, { build: 1 })
  assert.deepEqual(insideValue, { build: 2 }, 'built again in the scratch values')
  assert.equal(registry.materialize(dep), outside, 'the file’s own value is untouched')
})

test('an automock asked for again while its real load runs gets an empty automock, not a loop (review High 5)', () => {
  const tree = tempTree('provino-cycle-')
  const a = tree.write('a.ts')
  const b = tree.write('b.ts')
  const loads: string[] = []
  const policy = { ...jestLike, automock: true }
  let seenFromB: unknown
  const registry = createModuleMockRegistry({
    policy,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: fakeResolver({ './a': a, './b': b }),
    roots: [tree.dir],
    extensions: ['.ts'],
    // a's real load imports b, and b's imports a: each goes through decide and materialize.
    loadActual: (id) => {
      loads.push(id)
      if (id === a) {
        const decision = registry.decide(b, a, 'cjs', './b')
        if (decision.mocked) registry.materialize(decision.id)
        return { fa: () => 'a' }
      }
      const decision = registry.decide(a, b, 'cjs', './a')
      if (decision.mocked) seenFromB = registry.materialize(decision.id)
      return { fb: () => 'b' }
    },
  })
  const mocked = registry.materialize(a) as { fa: () => unknown }
  assert.equal(mocked.fa(), undefined)
  assert.deepEqual(loads, [a, b], 'each real module loaded once')
  assert.deepEqual(seenFromB, {}, 'b saw an empty automock of a, mid-build')
  // After the build, a is a real automock again for every caller.
  assert.equal(typeof (registry.materialize(a) as { fa?: unknown }).fa, 'function')
})

test('under an async actual, only the synchronous part of the load sees the scratch values', async () => {
  const tree = tempTree('provino-scratch-async-')
  const auto = tree.write('auto.ts')
  const registry = createModuleMockRegistry({
    policy: vitestLike,
    mockPolicy: neutral,
    mocks: createMockRegistry(),
    resolver: fakeResolver({ './auto': auto }),
    roots: [tree.dir],
    extensions: ['.ts'],
    loadActual: async () => ({ f: () => 1 }),
  })
  registry.register('./auto', { kind: 'automock', spy: false }, { from: join(tree.dir, 't.ts') })
  const value = (await registry.materialize(auto)) as { f: () => unknown }
  assert.equal(value.f(), undefined)
})

test('active is decide`s fast path inverted: a registration, automock-all or a root mock makes it true', () => {
  const build = (rootMockFiles: readonly string[], policy = jestLike) => {
    const tree = tempTree('provino-active-')
    for (const file of rootMockFiles) tree.write(file)
    return createModuleMockRegistry({
      policy,
      mockPolicy: neutral,
      mocks: createMockRegistry(),
      resolver: fakeResolver({}),
      roots: [tree.dir],
      extensions: ['.ts'],
      loadActual: () => ({}),
    })
  }
  const idle = build([])
  assert.equal(idle.active(), false)
  idle.setAutomock(true)
  assert.equal(idle.active(), true)
  idle.setAutomock(false)
  assert.equal(idle.active(), false)
  assert.equal(
    build(['__mocks__/pkg.ts']).active(),
    true,
    'a root mock applies by itself under Jest',
  )
  assert.equal(
    build(['__mocks__/pkg.ts'], { ...jestLike, rootMocksAutoApply: false }).active(),
    false,
    'and not where root mocks need a call',
  )
  const registered = build([])
  registered.register(
    'virtual-pkg',
    { kind: 'factory', factory: () => ({}) },
    {
      from: '/proj/t.ts',
      virtual: true,
    },
  )
  assert.equal(registered.active(), true)
})

test('generation changes with what decide can answer: a registration, automock-all, a reset that clears them', () => {
  const tree = tempTree('provino-generation-')
  const build = (policy = jestLike) =>
    createModuleMockRegistry({
      policy,
      mockPolicy: neutral,
      mocks: createMockRegistry(),
      resolver: fakeResolver({}),
      roots: [tree.dir],
      extensions: ['.ts'],
      loadActual: () => ({}),
    })
  const registry = build()
  const start = registry.generation()
  assert.equal(registry.generation(), start, 'asking changes nothing')
  registry.decide('/proj/a.ts', '/proj/t.ts', 'cjs')
  registry.enterIsolation()
  registry.exitIsolation()
  registry.onResetModules()
  assert.equal(registry.generation(), start, 'a decision, an isolation and a plain reset do not')
  registry.register(
    'virtual-pkg',
    { kind: 'factory', factory: () => ({}) },
    { from: '/proj/t.ts', virtual: true },
  )
  const registered = registry.generation()
  assert.notEqual(registered, start)
  registry.setAutomock(true)
  assert.notEqual(registry.generation(), registered)
  const clearing = build({ ...jestLike, resetModulesClearsMocks: true })
  clearing.register(
    'virtual-pkg',
    { kind: 'factory', factory: () => ({}) },
    { from: '/proj/t.ts', virtual: true },
  )
  const before = clearing.generation()
  clearing.onResetModules()
  assert.notEqual(clearing.generation(), before)
})
