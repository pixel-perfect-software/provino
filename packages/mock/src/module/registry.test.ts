import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { ModuleId } from '@provino/types'
import { MockError, MockTypeError } from '../errors.ts'
import { neutral } from '../internal/test-support.ts'
import { isMockFunction } from '../mock-fn.ts'
import { build, jestLike, vitestLike } from './test-support.ts'

const FROM = '/proj/test/a.test.ts'
const FILES = { './dep': '/proj/src/dep.ts', pkg: '/proj/node_modules/pkg/index.js' }

describe('decide: precedence', () => {
  test('nothing registered is not mocked', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    assert.deepEqual(registry.decide('/proj/src/dep.ts', FROM, 'esm'), { mocked: false })
  })

  test('an explicit registration mocks the id, and an unmock after it does not', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    assert.deepEqual(registry.decide('/proj/src/dep.ts', FROM, 'cjs'), {
      mocked: true,
      id: '/proj/src/dep.ts',
    })
    registry.register('./dep', { kind: 'unmock' }, { from: FROM })
    assert.deepEqual(registry.decide('/proj/src/dep.ts', FROM, 'cjs'), { mocked: false })
  })

  test('an explicit unmock beats automock-all, and automock-all beats nothing', () => {
    const { registry } = build({ policy: { ...jestLike, automock: true }, files: FILES })
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'esm').mocked, true)
    registry.register('./dep', { kind: 'unmock' }, { from: FROM })
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'esm').mocked, false)
    registry.setAutomock(false)
    assert.equal(registry.decide('/proj/src/other.ts', FROM, 'esm').mocked, false)
  })

  test('automock-all leaves core modules and unmockedPathPatterns alone', () => {
    const policy = { ...jestLike, automock: true, unmockedPathPatterns: [/\/keep\//g] }
    const { registry } = build({ policy })
    assert.equal(registry.decide('node:os', FROM, 'builtin').mocked, false)
    assert.equal(registry.decide('/proj/keep/x.ts', FROM, 'esm').mocked, false)
    assert.equal(
      registry.decide('/proj/keep/x.ts', FROM, 'esm').mocked,
      false,
      'a /g regexp keeps no state',
    )
    assert.equal(registry.decide('/proj/src/x.ts', FROM, 'esm').mocked, true)
  })

  test('an explicit mock beats an unmockedPathPattern', () => {
    const policy = { ...jestLike, automock: true, unmockedPathPatterns: [/dep/] }
    const { registry } = build({ policy, files: FILES })
    registry.register('./dep', { kind: 'automock', spy: false }, { from: FROM })
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'esm').mocked, true)
  })

  test('a core module is one id for node:os and os', () => {
    const { registry } = build({ policy: vitestLike })
    registry.register('os', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    assert.equal(registry.decide('node:os', FROM, 'builtin').mocked, true)
    assert.deepEqual(registry.decideUnresolved('os', FROM), { mocked: true, id: 'node:os' })
    assert.deepEqual(registry.decideUnresolved('node:os', FROM), { mocked: true, id: 'node:os' })
    registry.register('node:os', { kind: 'unmock' }, { from: FROM })
    assert.equal(registry.decide('node:os', FROM, 'builtin').mocked, false)
  })
})

describe('register', () => {
  test('a missing module needs the virtual flag under requireVirtualFlag', () => {
    const { registry } = build({ policy: jestLike })
    assert.throws(
      () => registry.register('./gone', { kind: 'factory', factory: () => ({}) }, { from: FROM }),
      (error: unknown) =>
        error instanceof MockError &&
        error.code === 'module-missing' &&
        error.message === "Cannot find module './gone' from 'test/a.test.ts' (hint)",
    )
    registry.register(
      './gone',
      { kind: 'factory', factory: () => ({}) },
      { from: FROM, virtual: true },
    )
  })

  test('the neutral text applies where the policy gives none', () => {
    const { registry } = build({ policy: { ...jestLike, messages: {} } })
    assert.throws(
      () => registry.register('nope', { kind: 'automock', spy: false }, { from: FROM }),
      /Cannot find module 'nope' from 'test\/a\.test\.ts'/,
    )
  })

  test('under requireVirtualFlag: false a missing module registers as virtual', () => {
    const { registry } = build({ policy: vitestLike })
    registry.register('nope', { kind: 'factory', factory: () => ({ a: 1 }) }, { from: FROM })
    assert.deepEqual(registry.decideUnresolved('nope', FROM), { mocked: true, id: 'virtual:nope' })
    assert.deepEqual(registry.materialize('virtual:nope') instanceof Promise, true)
  })

  test('a relative virtual specifier resolves against the importer', () => {
    const { registry } = build({ policy: jestLike })
    registry.register(
      './v',
      { kind: 'factory', factory: () => ({ v: 1 }) },
      { from: FROM, virtual: true },
    )
    assert.deepEqual(registry.decideUnresolved('./v', FROM), {
      mocked: true,
      id: 'virtual:/proj/test/v',
    })
    assert.deepEqual(registry.decideUnresolved('./v', '/proj/other/b.test.ts'), { mocked: false })
    assert.deepEqual(registry.materialize('virtual:/proj/test/v'), { v: 1 })
  })

  test('virtualRelative false: importing a mocked relative path that is not on disk fails, a bare name works', () => {
    const { registry } = build({
      policy: {
        ...vitestLike,
        virtualRelative: false,
        messages: { 'unresolved-relative-mock': "Cannot find module '{id}'" },
      },
    })
    registry.register('./v', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    registry.register('bare', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    assert.throws(() => registry.decideUnresolved('./v', FROM), {
      message: "Cannot find module '/test/v'",
    })
    assert.deepEqual(registry.decideUnresolved('bare', FROM), { mocked: true, id: 'virtual:bare' })
  })

  test('an unmock of a missing module is harmless', () => {
    const { registry } = build({ policy: jestLike })
    registry.register('./gone', { kind: 'unmock' }, { from: FROM })
    assert.deepEqual(registry.decideUnresolved('./gone', FROM), { mocked: false })
  })

  test('registering again replaces the entry and drops the cached value (doMock)', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ n: 1 }) }, { from: FROM })
    assert.deepEqual(registry.materialize('/proj/src/dep.ts'), { n: 1 })
    registry.register('./dep', { kind: 'factory', factory: () => ({ n: 2 }) }, { from: FROM })
    assert.deepEqual(registry.materialize('/proj/src/dep.ts'), { n: 2 })
  })

  test('a late registration applies on the next materialize without a reset', () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'esm').mocked, false)
    registry.register('./dep', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'esm').mocked, true)
  })
})

describe('materialize: factories', () => {
  test('the factory runs once per file, and importOriginal reaches loadActual', async () => {
    let runs = 0
    const { registry, loads } = build({
      policy: jestLike,
      files: FILES,
      actuals: { '/proj/src/dep.ts': { real: true } },
    })
    registry.register(
      './dep',
      {
        kind: 'factory',
        factory: async (importOriginal) => {
          runs++
          return { ...((await importOriginal()) as object), extra: 1 }
        },
      },
      { from: FROM },
    )
    const first = registry.materialize('/proj/src/dep.ts')
    assert.equal(registry.materialize('/proj/src/dep.ts'), first)
    assert.equal(runs, 1)
    assert.ok(first instanceof Promise, 'Jest: the module is the Promise')
    assert.deepEqual(await first, { real: true, extra: 1 })
    assert.deepEqual(loads, [['/proj/src/dep.ts', FROM]])
  })

  test('awaitFactory: a Promise comes back, and it resolves to the namespace', async () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: async () => ({ a: 1 }) }, { from: FROM })
    const value = registry.materialize('/proj/src/dep.ts')
    assert.ok(value instanceof Promise)
    assert.equal(((await value) as { a: number }).a, 1)
  })

  test('without awaitFactory a synchronous factory is a plain value', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ a: 1 }) }, { from: FROM })
    assert.deepEqual(registry.materialize('/proj/src/dep.ts'), { a: 1 })
  })

  test('module-value: a bare function is the module; { default } stays as returned', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    const fn = (): number => 1
    registry.register('./dep', { kind: 'factory', factory: () => fn }, { from: FROM })
    registry.register('pkg', { kind: 'factory', factory: () => ({ default: fn }) }, { from: FROM })
    assert.equal(registry.materialize('/proj/src/dep.ts'), fn)
    const pkg = registry.materialize('/proj/node_modules/pkg/index.js') as Record<string, unknown>
    assert.equal(pkg.default, fn)
    assert.equal('__esModule' in pkg, false)
  })

  test('missingFactoryExport undefined: reading an absent export gives undefined and costs no Proxy', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    const returned: Record<string, unknown> = { a: 1 }
    registry.register('./dep', { kind: 'factory', factory: () => returned }, { from: FROM })
    const value = registry.materialize('/proj/src/dep.ts') as Record<string, unknown>
    assert.equal(value, returned, 'no wrapper')
    assert.equal(value.b, undefined)
  })

  test('missingFactoryExport throw: a Proxy that throws on an absent export', async () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ a: 1 }) }, { from: FROM })
    const value = (await registry.materialize('/proj/src/dep.ts')) as Record<
      string | symbol,
      unknown
    >
    assert.equal(value.a, 1)
    assert.throws(() => value.b, { message: 'No "b" export is defined on the "./dep" mock' })
    // What a consumer reads without asking for an export.
    assert.equal(value.then, undefined)
    assert.equal(value.__esModule, undefined)
    assert.equal(value[Symbol.toStringTag], undefined)
    assert.equal('b' in value, false)
  })

  test('namespace: a bare function, an array, null and a primitive are refused', async () => {
    const { registry } = build({ policy: vitestLike, files: FILES })
    for (const bad of [() => 1, [], null, 'x']) {
      registry.register('./dep', { kind: 'factory', factory: () => bad }, { from: FROM })
      await assert.rejects(
        Promise.resolve(registry.materialize('/proj/src/dep.ts')),
        (error: unknown) =>
          error instanceof MockTypeError &&
          error.code === 'factory-not-object' &&
          error.message === 'The mock factory for "./dep" must return an object',
      )
    }
  })

  test('a failing factory is not cached, and a policy text wraps the cause', async () => {
    let fail = true
    const policy = { ...vitestLike, messages: { 'factory-error': 'while mocking' } }
    const { registry } = build({ policy, files: FILES })
    registry.register(
      './dep',
      {
        kind: 'factory',
        factory: () => {
          if (fail) throw new ReferenceError('tdz')
          return { ok: true }
        },
      },
      { from: FROM },
    )
    assert.throws(
      () => registry.materialize('/proj/src/dep.ts'),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'while mocking' &&
        error.cause instanceof ReferenceError,
    )
    fail = false
    assert.deepEqual(await registry.materialize('/proj/src/dep.ts'), { ok: true })
  })

  test('a rejected async factory is evicted, so the next materialize runs it again', async () => {
    let runs = 0
    const { registry } = build({ policy: vitestLike, files: FILES })
    registry.register(
      './dep',
      {
        kind: 'factory',
        factory: async () => {
          runs++
          if (runs === 1) throw new Error('first')
          return {}
        },
      },
      { from: FROM },
    )
    await assert.rejects(Promise.resolve(registry.materialize('/proj/src/dep.ts')), /first/)
    await Promise.resolve()
    await registry.materialize('/proj/src/dep.ts')
    assert.equal(runs, 2)
  })

  test('a redirect loads the other module', () => {
    const { registry, loads } = build({
      policy: jestLike,
      files: FILES,
      actuals: { '/proj/other.ts': { other: true } },
    })
    registry.register(
      './dep',
      { kind: 'redirect', to: '/proj/other.ts' as ModuleId },
      { from: FROM },
    )
    assert.deepEqual(registry.materialize('/proj/src/dep.ts'), { other: true })
    assert.deepEqual(loads, [['/proj/other.ts', FROM]])
  })
})

describe('resetModules', () => {
  test('a factory re-runs after onResetModules under resetModulesReRunsFactory', () => {
    let runs = 0
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ n: ++runs }) }, { from: FROM })
    const first = registry.materialize('/proj/src/dep.ts')
    registry.onResetModules()
    const second = registry.materialize('/proj/src/dep.ts')
    assert.notEqual(first, second)
    assert.equal(runs, 2)
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'cjs').mocked, true, 'still mocked')
  })

  test('the cached instance survives otherwise', () => {
    let runs = 0
    const policy = { ...vitestLike, resetModulesReRunsFactory: false }
    const { registry } = build({ policy, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ n: ++runs }) }, { from: FROM })
    const first = registry.materialize('/proj/src/dep.ts')
    registry.onResetModules()
    assert.equal(registry.materialize('/proj/src/dep.ts'), first)
    assert.equal(runs, 1)
  })

  test('resetModulesClearsMocks also forgets the registrations', () => {
    const policy = { ...jestLike, resetModulesClearsMocks: true }
    const { registry } = build({ policy, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    registry.onResetModules()
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'cjs').mocked, false)
  })
})

describe('isolation overlay', () => {
  test('outer instances are visible inside; new ones stay inside', () => {
    let runs = 0
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ n: ++runs }) }, { from: FROM })
    registry.register('pkg', { kind: 'factory', factory: () => ({ n: ++runs }) }, { from: FROM })
    const outer = registry.materialize('/proj/src/dep.ts')
    registry.enterIsolation()
    assert.equal(registry.materialize('/proj/src/dep.ts'), outer, 'outer instance visible')
    const inner = registry.materialize('/proj/node_modules/pkg/index.js')
    assert.equal(registry.materialize('/proj/node_modules/pkg/index.js'), inner)
    registry.exitIsolation()
    const after = registry.materialize('/proj/node_modules/pkg/index.js')
    assert.notEqual(after, inner, 'the inside instance is gone')
    assert.equal(runs, 3)
  })

  test('resetModules inside clears the outer values too', () => {
    let runs = 0
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({ n: ++runs }) }, { from: FROM })
    const outer = registry.materialize('/proj/src/dep.ts')
    registry.enterIsolation()
    registry.onResetModules()
    assert.notEqual(registry.materialize('/proj/src/dep.ts'), outer)
  })

  test('nesting throws the dialect text, and the block can be entered again after exit', () => {
    const policy = {
      ...jestLike,
      messages: {
        'nested-isolation': '{caller} cannot be nested inside another {caller} or {other}.',
      },
    }
    const { registry } = build({ policy })
    registry.enterIsolation('isolateModules', 'isolateModulesAsync')
    assert.throws(() => registry.enterIsolation('isolateModulesAsync', 'isolateModules'), {
      message:
        'isolateModulesAsync cannot be nested inside another isolateModulesAsync or isolateModules.',
    })
    registry.exitIsolation()
    registry.enterIsolation()
    registry.exitIsolation()
  })
})

describe('dispose', () => {
  test('forgets everything, and later calls throw', () => {
    const { registry } = build({ policy: jestLike, files: FILES })
    registry.register('./dep', { kind: 'factory', factory: () => ({}) }, { from: FROM })
    registry.dispose()
    assert.equal(registry.decide('/proj/src/dep.ts', FROM, 'cjs').mocked, false)
    assert.throws(() => registry.materialize('/proj/src/dep.ts'), { code: 'registry-disposed' })
    assert.throws(
      () => registry.register('./dep', { kind: 'unmock' }, { from: FROM }),
      (error: unknown) => error instanceof MockError && error.code === 'registry-disposed',
    )
  })
})

describe('__mocks__', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provino-mock-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  const write = (path: string): string => {
    const file = join(dir, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '')
    return file
  }
  const rootPkg = write('__mocks__/pkg.ts')
  const rootScoped = write('__mocks__/@scope/lib.ts')
  const rootOs = write('__mocks__/os.ts')
  const adjacent = write('src/__mocks__/dep.ts')
  const dep = write('src/dep.ts')
  const plain = write('src/plain.ts')
  const importer = join(dir, 'test/a.test.ts')
  const files = {
    pkg: join(dir, 'node_modules/pkg/index.js'),
    '@scope/lib': join(dir, 'node_modules/@scope/lib/index.js'),
    './dep': dep,
    './plain': plain,
  }
  const actuals = Object.fromEntries(
    [rootPkg, rootScoped, rootOs, adjacent].map((file) => [file, { from: file }]),
  )

  test('rootMocksAutoApply: a plain and a scoped package are mocked with no call', () => {
    const { registry, loads } = build({ policy: jestLike, files, roots: [dir], actuals })
    const pkgId = files.pkg
    assert.deepEqual(registry.decide(pkgId, importer, 'cjs', 'pkg'), { mocked: true, id: pkgId })
    assert.deepEqual(registry.materialize(pkgId), { from: rootPkg })
    const scopedId = files['@scope/lib']
    assert.equal(registry.decide(scopedId, importer, 'cjs', '@scope/lib').mocked, true)
    assert.deepEqual(registry.materialize(scopedId), { from: rootScoped })
    assert.equal(loads.length, 2)
  })

  test('the package name is taken from the path when no specifier is passed', () => {
    const { registry } = build({ policy: jestLike, files, roots: [dir], actuals })
    assert.equal(registry.decide(files['@scope/lib'], importer, 'cjs').mocked, true)
  })

  test('not under rootMocksAutoApply: false', () => {
    const { registry } = build({ policy: vitestLike, files, roots: [dir], actuals })
    assert.equal(registry.decide(files.pkg, importer, 'esm', 'pkg').mocked, false)
  })

  test('a root core mock is not applied without a call, and is with one', () => {
    const { registry } = build({ policy: jestLike, roots: [dir], actuals })
    assert.equal(registry.decide('node:os', importer, 'builtin').mocked, false)
    assert.deepEqual(registry.decideUnresolved('os', importer), { mocked: false })
    registry.register('node:os', { kind: 'automock', spy: false }, { from: importer })
    assert.deepEqual(registry.decide('node:os', importer, 'builtin'), {
      mocked: true,
      id: 'node:os',
    })
    assert.deepEqual(
      registry.materialize('node:os'),
      { from: rootOs },
      'mock("node:os") finds __mocks__/os',
    )
  })

  test('an adjacent mock applies only with mock()', () => {
    const { registry } = build({ policy: jestLike, files, roots: [dir], actuals })
    assert.equal(registry.decide(dep, importer, 'esm').mocked, false)
    registry.register('./dep', { kind: 'automock', spy: false }, { from: importer })
    assert.equal(registry.decide(dep, importer, 'esm').mocked, true)
    assert.deepEqual(registry.materialize(dep), { from: adjacent })
  })

  test('mock(p) with nothing adjacent automocks the real module', () => {
    const { registry } = build({
      policy: jestLike,
      files,
      roots: [dir],
      actuals: { [plain]: { fn() {} } },
    })
    registry.register('./plain', { kind: 'automock', spy: false }, { from: importer })
    const mocked = registry.materialize(plain) as { fn: unknown }
    assert.ok(isMockFunction(neutral, mocked.fn))
  })

  test('a spy never prefers the manual mock', () => {
    const real = { fn: () => 1 }
    const { registry } = build({
      policy: vitestLike,
      files,
      roots: [dir],
      actuals: { [dep]: real, [adjacent]: { from: adjacent } },
    })
    registry.register('./dep', { kind: 'automock', spy: true }, { from: importer })
    const mocked = registry.materialize(dep) as { fn: () => number }
    assert.equal(mocked.fn(), 1, 'calls through')
    assert.ok(isMockFunction(neutral, mocked.fn))
  })

  test('decideUnresolved: a root-mocked package that is not installed', () => {
    const { registry } = build({ policy: jestLike, files: {}, roots: [dir], actuals })
    assert.deepEqual(registry.decideUnresolved('pkg', importer), {
      mocked: true,
      id: 'virtual:pkg',
    })
    assert.deepEqual(registry.materialize('virtual:pkg'), { from: rootPkg })
    assert.deepEqual(registry.decideUnresolved('nothing', importer), { mocked: false })
  })

  test('mock() of a missing package passes without the flag when a root mock exists', () => {
    const { registry } = build({ policy: jestLike, files: {}, roots: [dir], actuals })
    registry.register('pkg', { kind: 'automock', spy: false }, { from: importer })
    assert.deepEqual(registry.materialize('virtual:pkg'), { from: rootPkg })
  })

  test('automock-all with a manual mock beside the module uses the manual mock', () => {
    const { registry } = build({
      policy: { ...jestLike, automock: true },
      files,
      roots: [dir],
      actuals,
    })
    assert.deepEqual(registry.decide(dep, importer, 'cjs'), { mocked: true, id: dep })
    assert.deepEqual(registry.materialize(dep), { from: adjacent })
  })
})

describe('automock through the registry', () => {
  test('automocks the loaded exports with the file policy, and caches the result', () => {
    const { registry } = build({
      policy: jestLike,
      files: FILES,
      actuals: { '/proj/src/dep.ts': { add: (a: number, b: number) => a + b, n: 1 } },
    })
    registry.register('./dep', { kind: 'automock', spy: false }, { from: FROM })
    const mocked = registry.materialize('/proj/src/dep.ts') as {
      add: (...args: number[]) => unknown
      n: number
    }
    assert.equal(mocked.add(1, 2), undefined)
    assert.equal(mocked.n, 1)
    assert.equal(registry.materialize('/proj/src/dep.ts'), mocked)
  })

  test('an async loadActual gives a Promise', async () => {
    const { registry } = build({
      policy: vitestLike,
      files: FILES,
      actuals: { '/proj/src/dep.ts': Promise.resolve({ f() {} }) },
    })
    registry.register('./dep', { kind: 'automock', spy: false }, { from: FROM })
    const value = registry.materialize('/proj/src/dep.ts')
    assert.ok(value instanceof Promise)
    assert.ok(isMockFunction(neutral, ((await value) as { f: unknown }).f))
  })

  test('a module Jest has no metadata for is an error with the dialect text', () => {
    const { registry } = build({
      policy: { ...jestLike, messages: { 'automock-no-metadata': 'Failed: {id}' } },
      files: FILES,
      actuals: { '/proj/src/dep.ts': new Date(0) },
    })
    registry.register('./dep', { kind: 'automock', spy: false }, { from: FROM })
    assert.throws(() => registry.materialize('/proj/src/dep.ts'), {
      message: 'Failed: /proj/src/dep.ts',
    })
  })
})
