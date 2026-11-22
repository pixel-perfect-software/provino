// B27f follow-up: what a user's TypeScript sees of the built packages. The dialects register
// themselves on `DialectRegistry` by declaration merging; a user's install has no `@provino/types`,
// so an augmentation that named it merged into nothing, `DialectName` was `never` and
// `defineConfig({ dialect: 'jest' })` failed with TS2322. The built declarations now name
// `provino/config`, which exports the registries. This compiles consumers against copies of the
// built `provino` and both add-ons (no `@provino/types` anywhere, `skipLibCheck: false`) on both
// compilers, and has one augmentation reach every public type that reads a registry.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { builtSources } from './dist.ts'
import { COMPILERS, compilerBin, copyBuiltPackage, linkDependencies, scratch } from './support.ts'

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

/** The compiler over the consumer: its exit code and what it printed. */
function compile(compiler: (typeof COMPILERS)[number], dir: string) {
  const run = spawnSync(process.execPath, [compilerBin(compiler), '-p', dir, '--pretty', 'false'], {
    encoding: 'utf8',
  })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

describe('the built declarations, as a user compiles them', () => {
  // One program: the add-ons imported, and one augmentation of each registry that every public
  // type reading it must see. `provino/internal/types` is the add-ons' own copy of those types.
  const withAddOns = consumer(
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
  )
  // `provino` alone: `provino/jest` and `provino/vitest` carry the declarations of their dialect.
  const alone = consumer(
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
    },
    false,
  )

  for (const compiler of COMPILERS) {
    test(`the add-ons' names and a user's augmentation reach every registry reader (${compiler})`, () => {
      const { status, output } = compile(compiler, withAddOns)
      assert.equal(status, 0, output)
    })

    test(`provino/jest and provino/vitest register their dialect without the add-ons (${compiler})`, () => {
      const { status, output } = compile(compiler, alone)
      assert.equal(status, 0, output)
    })
  }

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
