// Registry behaviour added by the B13b pre-merge review (lane 3): sub-path root mocks, dual
// packages, factory failures and re-entry, and error codes. `registry.test.ts` has the rest.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { ResolveContext, Resolver } from '@provino/types'
import { MockError } from '../errors.ts'
import { build, jestLike, resolverBy, tempTree, vitestLike } from './test-support.ts'

const FROM = '/proj/test/a.test.ts'
const FILES = { './dep': '/proj/src/dep.ts' }

describe('a root mock named by a sub-path specifier', () => {
  const { dir, write } = tempTree('provino-mock-sub-')
  const rootSub = write('__mocks__/pkg/sub.ts')
  const rootPkg = write('__mocks__/pkg.ts')
  const rootScopedSub = write('__mocks__/@scope/lib/sub.ts')
  const importer = join(dir, 'test/a.test.ts')
  const files = {
    'pkg/sub': join(dir, 'node_modules/pkg/sub.js'),
    'other/sub': join(dir, 'node_modules/other/sub.js'),
    '@scope/lib/sub': join(dir, 'node_modules/@scope/lib/sub.js'),
  }
  const actuals = Object.fromEntries(
    [...Object.values(files), rootSub, rootPkg, rootScopedSub].map((file) => [
      file,
      { fn: () => 1, from: file },
    ]),
  )

  test('pkg/sub is the mock __mocks__/pkg/sub.ts, not a re-derived pkg', () => {
    const { registry, loads } = build({ policy: jestLike, files, roots: [dir], actuals })
    const id = files['pkg/sub']
    assert.deepEqual(registry.decide(id, importer, 'cjs', 'pkg/sub'), { mocked: true, id })
    assert.equal((registry.materialize(id) as { from: string }).from, rootSub)
    assert.deepEqual(
      loads.map(([path]) => path),
      [rootSub],
      'the real pkg/sub never loads',
    )
  })

  test('a scoped package sub-path finds its own root mock', () => {
    const { registry } = build({ policy: jestLike, files, roots: [dir], actuals })
    const id = files['@scope/lib/sub']
    assert.equal(registry.decide(id, importer, 'cjs', '@scope/lib/sub').mocked, true)
    assert.equal((registry.materialize(id) as { from: string }).from, rootScopedSub)
  })

  test('under automock-all, a sub-path with no mock of its own is automocked, not given __mocks__/pkg.ts', () => {
    const { registry, loads } = build({
      policy: { ...jestLike, automock: true },
      files,
      roots: [dir],
      actuals,
    })
    const id = files['other/sub']
    assert.equal(registry.decide(id, importer, 'cjs', 'other/sub').mocked, true)
    registry.materialize(id)
    assert.deepEqual(
      loads.map(([path]) => path),
      [id],
    )
    const sub = join(dir, 'node_modules/pkg/deep.js')
    const other = build({
      policy: { ...jestLike, automock: true },
      roots: [dir],
      actuals: { ...actuals, [sub]: { fn: () => 1 } },
    })
    other.registry.decide(sub, importer, 'cjs', 'pkg/deep')
    other.registry.materialize(sub)
    assert.deepEqual(
      other.loads.map(([path]) => path),
      [sub],
      'pkg/deep must not receive __mocks__/pkg.ts',
    )
  })

  test('a relative import inside a package does not find the package root mock', () => {
    const { registry } = build({ policy: jestLike, files, roots: [dir], actuals })
    const inner = join(dir, 'node_modules/pkg/inner.js')
    assert.equal(
      registry.decide(inner, join(dir, 'node_modules/pkg/index.js'), 'cjs', './inner').mocked,
      false,
    )
  })
})

/** A resolver whose answer depends on the kind, like a package with `import` and `require` exports. */
function dualResolver(
  answers: Partial<Record<ResolveContext['kind'], string | null>>,
  seen: string[] = [],
): Resolver {
  return resolverBy((_specifier, context) => {
    seen.push(context.kind)
    return answers[context.kind]
  })
}

describe('a dual package', () => {
  const ESM = '/proj/node_modules/dual/index.mjs'
  const CJS = '/proj/node_modules/dual/index.cjs'

  test('a mock registers under the id of each kind, and both share one entry and one value', () => {
    let runs = 0
    const { registry } = build({
      policy: jestLike,
      resolver: dualResolver({ mock: CJS, import: ESM, require: CJS }),
    })
    registry.register(
      'dual',
      {
        kind: 'factory',
        factory: () => {
          runs += 1
          return { n: runs }
        },
      },
      { from: FROM },
    )
    const viaImport = registry.decide(ESM, FROM, 'esm')
    const viaRequire = registry.decide(CJS, FROM, 'cjs')
    assert.ok(viaImport.mocked && viaRequire.mocked)
    const first = registry.materialize(viaImport.id)
    assert.equal(registry.materialize(viaRequire.id), first, 'one cached value')
    assert.equal(runs, 1)
  })

  test('an unmock covers both ids', () => {
    const { registry } = build({
      policy: { ...jestLike, automock: true },
      resolver: dualResolver({ mock: CJS, import: ESM, require: CJS }),
    })
    registry.register('dual', { kind: 'unmock' }, { from: FROM })
    assert.equal(registry.decide(ESM, FROM, 'esm').mocked, false)
    assert.equal(registry.decide(CJS, FROM, 'cjs').mocked, false)
  })

  test('a kind that does not resolve is skipped', () => {
    const seen: string[] = []
    const { registry } = build({
      policy: jestLike,
      resolver: dualResolver({ mock: CJS, import: null, require: CJS }, seen),
    })
    registry.register('dual', { kind: 'factory', factory: () => ({ n: 1 }) }, { from: FROM })
    assert.ok(seen.includes('import') && seen.includes('require'))
    assert.equal(registry.decide(CJS, FROM, 'cjs').mocked, true)
    assert.equal(registry.decide(ESM, FROM, 'esm').mocked, false)
  })

  test('registering again replaces the shared value for both ids under mockValueOwner registration', async () => {
    const { registry } = build({
      policy: vitestLike,
      resolver: dualResolver({ mock: CJS, import: ESM, require: CJS }),
    })
    registry.register('dual', { kind: 'factory', factory: () => ({ n: 1 }) }, { from: FROM })
    assert.deepEqual(await registry.materialize(ESM), { n: 1 })
    registry.register('dual', { kind: 'factory', factory: () => ({ n: 2 }) }, { from: FROM })
    assert.deepEqual(await registry.materialize(CJS), { n: 2 })
    assert.deepEqual(await registry.materialize(ESM), { n: 2 })
  })

  test('registering again keeps the shared value for both ids until a reset under module-registry', () => {
    const { registry } = build({
      policy: jestLike,
      resolver: dualResolver({ mock: CJS, import: ESM, require: CJS }),
    })
    registry.register('dual', { kind: 'factory', factory: () => ({ n: 1 }) }, { from: FROM })
    assert.deepEqual(registry.materialize(ESM), { n: 1 })
    registry.register('dual', { kind: 'factory', factory: () => ({ n: 2 }) }, { from: FROM })
    assert.deepEqual(registry.materialize(CJS), { n: 1 })
    registry.onResetModules()
    assert.deepEqual(registry.materialize(ESM), { n: 2 })
    assert.deepEqual(registry.materialize(CJS), { n: 2 })
  })
})

describe('factory failures and re-entry', () => {
  test('a synchronous throw under awaitFactory is a rejected Promise, not a throw', async () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    registry.register(
      './dep',
      {
        kind: 'factory',
        factory: () => {
          throw new Error('boom')
        },
      },
      { from: FROM },
    )
    let value: unknown
    assert.doesNotThrow(() => {
      value = registry.materialize('/proj/src/dep.ts')
    })
    assert.ok(value instanceof Promise)
    await assert.rejects(value, { message: 'boom' })
  })

  test('a factory that materializes its own module throws a coded error, and nothing is cached', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register(
      './dep',
      { kind: 'factory', factory: () => registry.materialize('/proj/src/dep.ts') },
      { from: FROM },
    )
    assert.throws(
      () => registry.materialize('/proj/src/dep.ts'),
      (error: unknown) =>
        error instanceof MockError &&
        error.code === 'circular-mock' &&
        /\.\/dep/.test(error.message),
    )
    registry.register('./dep', { kind: 'factory', factory: () => ({ ok: 1 }) }, { from: FROM })
    assert.deepEqual(registry.materialize('/proj/src/dep.ts'), { ok: 1 })
  })

  test('an async factory that awaits its own module rejects with the code instead of hanging', async () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    registry.register(
      './dep',
      {
        kind: 'factory',
        factory: async () => {
          await Promise.resolve()
          return await (registry.materialize('/proj/src/dep.ts') as Promise<unknown>)
        },
      },
      { from: FROM },
    )
    // A hang fails by the test's own timeout.
    await assert.rejects(Promise.resolve(registry.materialize('/proj/src/dep.ts')), {
      code: 'circular-mock',
    })
  })

  test('two unrelated async importers of one pending mock both get the value', async () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    registry.register(
      './dep',
      { kind: 'factory', factory: async () => ({ ok: 1 }) },
      { from: FROM },
    )
    const [a, b] = await Promise.all([
      registry.materialize('/proj/src/dep.ts'),
      registry.materialize('/proj/src/dep.ts'),
    ])
    assert.deepEqual(a, { ok: 1 })
    assert.equal(a, b)
  })
})

describe('errors carry a code', () => {
  test('missing-factory-export keeps its name and message', () => {
    const { registry } = build({
      policy: { ...vitestLike, missingFactoryExport: 'throw', awaitFactory: false },
      files: FILES,
    })
    registry.register('./dep', { kind: 'factory', factory: () => ({ a: 1 }) }, { from: FROM })
    const mod = registry.materialize('/proj/src/dep.ts') as { b?: unknown }
    assert.throws(
      () => mod.b,
      (error: unknown) =>
        error instanceof MockError &&
        error.name === 'Error' &&
        error.code === 'missing-factory-export' &&
        error.message === 'No "b" export is defined on the "./dep" mock',
    )
  })

  test('nested-isolation keeps its name and message', () => {
    const { registry } = build({ policy: { ...jestLike, messages: {} } })
    registry.enterIsolation()
    assert.throws(
      () => registry.enterIsolation(),
      (error: unknown) =>
        error instanceof MockError &&
        error.name === 'Error' &&
        error.code === 'nested-isolation' &&
        error.message ===
          'isolateModules cannot be nested inside another isolateModules or isolateModulesAsync',
    )
  })

  test('unresolved-relative-mock keeps its name and message', () => {
    const { registry } = build({ policy: { ...vitestLike, virtualRelative: false } })
    registry.register(
      './gone',
      { kind: 'factory', factory: () => ({}) },
      { from: FROM, virtual: true },
    )
    assert.throws(
      () => registry.decideUnresolved('./gone', FROM),
      (error: unknown) =>
        error instanceof MockError &&
        error.name === 'Error' &&
        error.code === 'unresolved-relative-mock' &&
        error.message === "Cannot find module '/test/gone'",
    )
  })
})
