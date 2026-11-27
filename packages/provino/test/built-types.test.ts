// B27f follow-up: what a user's TypeScript sees of the built packages. The dialects register
// themselves on `DialectRegistry` by declaration merging; a user's install has no `@provino/types`,
// so an augmentation that named it merged into nothing, `DialectName` was `never` and
// `defineConfig({ dialect: 'jest' })` failed with TS2322. The built declarations now name
// `provino/config`, which exports the registries. This compiles consumers against copies of the
// built `provino` and both add-ons (no `@provino/types` anywhere, `skipLibCheck: false`) on both
// compilers, and has one augmentation reach every public type that reads a registry.
// B27i: the root entry's `types` file was a shared declaration chunk (its names mangled, `$`, `_`,
// `A`…), so `import { describe } from 'provino'` failed with TS2305; a user compiles the native API
// here, and each public entry's `types` file must export exactly its source entry's names.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { describe, test } from 'provino'
import { builtSources } from './dist.ts'
import {
  COMPILERS,
  compilerBin,
  copyBuiltPackage,
  linkDependencies,
  once,
  scratch,
} from './support.ts'

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url))
const ROOT = join(PACKAGES, '..')

/** Installs the built workspace package `name` at `target`, with its third-party packages linked. */
function install(name: string, target: string): void {
  const from = join(PACKAGES, name)
  copyBuiltPackage(target, from)
  linkDependencies(from, target, ['@provino', 'provino'])
}

/** A consumer project: `provino` (and the add-ons when asked) installed as a user has them. */
function consumer(files: Readonly<Record<string, string>>, addOns: boolean): string {
  const dir = scratch('provino-consumer-')
  install('provino', join(dir, 'node_modules', 'provino'))
  if (addOns) {
    install('dialect-jest', join(dir, 'node_modules', '@provino', 'dialect-jest'))
    install('dialect-vitest', join(dir, 'node_modules', '@provino', 'dialect-vitest'))
  }
  const tsconfig = {
    compilerOptions: {
      target: 'esnext',
      lib: ['esnext'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      skipLibCheck: false,
      typeRoots: [join(ROOT, 'node_modules', '@types')],
      types: ['node'],
    },
    include: ['*.ts'],
  }
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

/**
 * The names a module exports, read by Oxc's parser (`export { a as b }`, `export const`,
 * `export type { … } from`, `export default` as `default`), once each (an overload, or a value and a
 * type of one name, is listed again in a source but once in a bundled file), sorted. `export *` is
 * refused: its names can't be read here.
 */
function exportedNames(path: string): string[] {
  const { module, errors } = parseSync(path, readFileSync(path, 'utf8'))
  assert.deepEqual(errors, [], `${path} does not parse`)
  const names = new Set<string>()
  for (const entry of module.staticExports) {
    for (const item of entry.entries) {
      const { kind, name } = item.exportName
      assert.notEqual(kind, 'None', `${path}: an export *, whose names can't be read`)
      names.add(kind === 'Default' ? 'default' : (name ?? ''))
    }
  }
  return [...names].sort()
}

/** The compiler over the consumer: its exit code and what it printed. */
function compile(compiler: (typeof COMPILERS)[number], dir: string) {
  const run = spawnSync(process.execPath, [compilerBin(compiler), '-p', dir, '--pretty', 'false'], {
    encoding: 'utf8',
  })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

describe('the built declarations, as a user compiles them', () => {
  // Each consumer is installed by the first test that compiles it, not as the file loads (a
  // listing imports the file), and reused by the other compiler's test.
  // One program: the add-ons imported, and one augmentation of each registry that every public
  // type reading it must see. `provino/internal/types` is the add-ons' own copy of those types.
  const withAddOns = once(() =>
    consumer(
      {
        'config.ts': [
          "import { jestDialect } from '@provino/dialect-jest'",
          "import { vitestDialect } from '@provino/dialect-vitest'",
          "import { defineConfig, type DialectKeys, type PluginKeys, type ProjectConfig } from 'provino/config'",
          "import type { DialectName } from 'provino/internal/types'",
          "declare module 'provino/config' {",
          '  interface DialectRegistry { custom: { level: number } }',
          '  interface PluginRegistry { msw: { quiet: boolean } }',
          '}',
          "export const jest = defineConfig({ dialect: 'jest', jest: {} })",
          "export const vitest = defineConfig({ dialect: 'vitest', vitest: {} })",
          'export const both = defineConfig({ dialects: [jestDialect, vitestDialect] })',
          '// @ts-expect-error: no dialect is called mocha',
          "export const unknown = defineConfig({ dialect: 'mocha' })",
          "export const custom = defineConfig({ dialect: 'custom', custom: { level: 1 } })",
          '// @ts-expect-error: the option is a number',
          "export const wrong = defineConfig({ dialect: 'custom', custom: { level: 'x' } })",
          'export const plugin = defineConfig({ msw: { quiet: true } })',
          "export const dialectKey: keyof DialectKeys = 'custom'",
          "export const pluginKey: keyof PluginKeys = 'msw'",
          "export const projectDialect: ProjectConfig['dialect'] = 'custom'",
          "export const internalCustom: DialectName = 'custom'",
          "export const internalJest: DialectName = 'jest'",
          '// @ts-expect-error: no dialect is called mocha',
          "export const internalUnknown: DialectName = 'mocha'",
          '',
        ].join('\n'),
      },
      true,
    ),
  )
  // `provino` alone, as a native project has it: `provino/jest` and `provino/vitest` carry the
  // declarations of their dialect, and `import … from 'provino'` types the main names of the native
  // API, each used as a value (the names test below covers every export).
  const alone = once(() =>
    consumer(
      {
        'config.ts': [
          "import 'provino/jest'",
          "import 'provino/vitest'",
          "import { defineConfig } from 'provino/config'",
          "export const jest = defineConfig({ dialect: 'jest' })",
          "export const vitest = defineConfig({ dialect: 'vitest' })",
          '// @ts-expect-error: no dialect is called mocha',
          "export const unknown = defineConfig({ dialect: 'mocha' })",
          '',
        ].join('\n'),
        'native.ts': [
          'import {',
          '  afterAll, afterEach, aroundAll, aroundEach, beforeAll, beforeEach, describe, expect, fn,',
          '  importActual, isMockFunction, it, lazy, mock, mocked, mocks, onTestFailed, onTestFinished,',
          '  ProvinoWorkerApiError, replaceProperty, requireActual, sharedExamples, spyOn, stubEnv, stubGlobal, suite, test, timers, unmock,',
          '  unstubAllEnvs, unstubAllGlobals,',
          "} from 'provino'",
          "mock('./dep.ts')",
          "unmock('./dep.ts')",
          "const $ = lazy.let('user', () => ({ name: 'ada' }))",
          "export const examples = sharedExamples<{ user: { name: string } }>('a user', () => {})",
          "describe('a suite', () => {",
          '  beforeAll(() => {})',
          '  afterAll(() => {})',
          '  beforeEach(() => {})',
          '  afterEach(() => {})',
          '  aroundEach(async (runTest) => { await runTest() })',
          '  aroundAll(async (runSuite) => { await runSuite() })',
          "  it('a test', async () => {",
          '    onTestFinished(() => {})',
          '    onTestFailed(() => {})',
          '    const add = fn((a: number, b: number) => a + b)',
          '    expect(add(1, 2)).toBe(3)',
          '    expect(isMockFunction(add)).toBe(true)',
          '    const service = { load: (id: number) => id, retries: 3 }',
          "    spyOn(service, 'load')",
          "    replaceProperty(service, 'retries', 5)",
          "    stubEnv('MODE', 'test')",
          "    stubEnv('MODE', undefined)",
          "    stubGlobal('flag', true)",
          '    unstubAllEnvs()',
          '    unstubAllGlobals()',
          '    mocks.restoreAll()',
          '    timers.useFakeTimers()',
          "    await importActual('./dep.ts')",
          "    requireActual('./dep.ts')",
          '    mocked(add).mockReturnValue(3)',
          "    expect($.user.name).toBe('ada')",
          '  })',
          '})',
          "suite('another', () => { test('runs', () => {}) })",
          "export const code: 'PROVINO_NO_WORKER_API' | 'PROVINO_NATIVE_ONLY' =",
          "  new ProvinoWorkerApiError('describe').code",
          '// @ts-expect-error: an env value is a string or undefined',
          "stubEnv('MODE', 1)",
          '// @ts-expect-error: a stub needs a value',
          "stubGlobal('flag')",
          '// @ts-expect-error: a test needs a name',
          'test()',
          '// @ts-expect-error: the specifier is a string',
          'mock(1)',
          '',
        ].join('\n'),
      },
      false,
    ),
  )

  for (const compiler of COMPILERS) {
    test(`the add-ons' names and a user's augmentation reach every registry reader (${compiler})`, () => {
      const { status, output } = compile(compiler, withAddOns())
      assert.equal(status, 0, output)
    })

    test(`provino alone types the native API, and provino/jest and provino/vitest register their dialect (${compiler})`, () => {
      const { status, output } = compile(compiler, alone())
      assert.equal(status, 0, output)
    })
  }

  test("each public entry's types file is its own declarations, exporting its source's names", () => {
    // A shared declaration chunk that takes an entry's file name exports other names (mangled ones),
    // and the entry's own declarations land in `<name>2.d.ts` or further: `types` then names the chunk.
    const dir = join(PACKAGES, 'provino')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
    }
    const entries = Object.entries(manifest.exports).filter(
      ([subpath, conditions]) =>
        !subpath.startsWith('./internal/') && conditions['provino-source']?.endsWith('.ts'),
    )
    // The subpaths a user's program needs; dropping some other entry must not fail this.
    const subpaths = entries.map(([subpath]) => subpath)
    for (const required of ['.', './config']) {
      assert.ok(
        subpaths.includes(required),
        `no public entry ${required} among ${subpaths.join(', ')}`,
      )
    }
    for (const [subpath, conditions] of entries) {
      const source = exportedNames(join(dir, conditions['provino-source'] ?? ''))
      const built = exportedNames(join(dir, conditions.types ?? ''))
      assert.deepEqual(
        built,
        source,
        `provino ${subpath}: ${conditions.types} is not its own declarations`,
      )
    }
  })

  test('no built declaration imports, re-exports or augments @provino/types, which no install has', () => {
    // A quoted specifier: `import`, `import type`, `import()`, `export … from` and `declare module`.
    const specifier = /["']@provino\/types["']/
    for (const name of ['provino', 'dialect-jest', 'dialect-vitest']) {
      const dist = join(PACKAGES, name, 'dist')
      for (const [path, text] of builtSources(dist, '.d.ts')) {
        assert.ok(!specifier.test(text), `${name}/dist/${path} names the module @provino/types`)
      }
    }
  })
})
