// B27f follow-up: what a user's TypeScript sees of the built packages. The dialects register
// themselves on `DialectRegistry` by declaration merging; a user's install has no `@provino/types`,
// so an augmentation that named it merged into nothing, `DialectName` was `never` and
// `defineConfig({ dialect: 'jest' })` failed with TS2322. The built declarations now name
// `provino/config`, which exports the registries. This compiles a consumer against copies of the
// built `provino` and both add-ons (no `@provino/types` anywhere, `skipLibCheck: false`), and holds
// each registry to one definition in the declarations.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { linkDependencies } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = join(PACKAGE, '..')
const ROOT = join(PACKAGES, '..')

/** Copies the built `dist` and manifest of a workspace package into `target`, with its dependencies linked. */
function install(name: string, target: string): void {
  const from = join(PACKAGES, name)
  mkdirSync(target, { recursive: true })
  cpSync(join(from, 'dist'), join(target, 'dist'), { recursive: true })
  cpSync(join(from, 'package.json'), join(target, 'package.json'))
  linkDependencies(from, target, ['@provino', 'provino'])
}

/** A consumer project: the three packages installed as a user has them, and `files` to compile. */
function consumer(files: Readonly<Record<string, string>>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-consumer-')))
  after(() => rmSync(dir, { recursive: true, force: true }))
  install('provino', join(dir, 'node_modules', 'provino'))
  install('dialect-jest', join(dir, 'node_modules', '@provino', 'dialect-jest'))
  install('dialect-vitest', join(dir, 'node_modules', '@provino', 'dialect-vitest'))
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

/** `tsc` over the consumer: its exit code and what it printed. */
function compile(dir: string): { status: number | null; output: string } {
  const run = spawnSync(join(PACKAGE, 'node_modules', '.bin', 'tsc'), ['-p', dir], {
    encoding: 'utf8',
  })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

describe('the built declarations, as a user compiles them', () => {
  test('defineConfig takes the dialect names the imported add-ons register', () => {
    const dir = consumer({
      'config.ts': [
        "import { jestDialect } from '@provino/dialect-jest'",
        "import { vitestDialect } from '@provino/dialect-vitest'",
        "import { defineConfig } from 'provino/config'",
        "export const jest = defineConfig({ dialect: 'jest', jest: {} })",
        "export const vitest = defineConfig({ dialect: 'vitest', vitest: {} })",
        'export const both = defineConfig({ dialects: [jestDialect, vitestDialect] })',
        '// @ts-expect-error: no dialect is called mocha',
        "export const unknown = defineConfig({ dialect: 'mocha' })",
        '',
      ].join('\n'),
    })
    const { status, output } = compile(dir)
    assert.equal(status, 0, output)
  })

  test('provino/jest and provino/vitest register their dialect without the add-on types', () => {
    const dir = consumer({
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
    })
    const { status, output } = compile(dir)
    assert.equal(status, 0, output)
  })

  test('a user augments the registries through provino/config', () => {
    const dir = consumer({
      'config.ts': [
        "import { defineConfig } from 'provino/config'",
        "declare module 'provino/config' {",
        '  interface DialectRegistry { custom: { level: number } }',
        '  interface PluginRegistry { msw: { quiet: boolean } }',
        '}',
        "export const custom = defineConfig({ dialect: 'custom', custom: { level: 1 } })",
        'export const plugin = defineConfig({ msw: { quiet: true } })',
        '// @ts-expect-error: the option is a number',
        "export const wrong = defineConfig({ dialect: 'custom', custom: { level: 'x' } })",
        '',
      ].join('\n'),
    })
    const { status, output } = compile(dir)
    assert.equal(status, 0, output)
  })

  test('each registry has one definition in the declarations', () => {
    const counts = new Map<string, number>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.d.ts')) {
          const text = readFileSync(path, 'utf8')
          for (const name of ['DialectRegistry', 'PluginRegistry', 'ProvidedContext']) {
            const own = text.match(new RegExp(`^interface ${name}(?:\\$\\d+)? \\{`, 'gm'))
            counts.set(name, (counts.get(name) ?? 0) + (own?.length ?? 0))
          }
          // The dialects' augmentations name the one module a user resolves.
          assert.ok(
            !/declare module ["']@provino\/types["']/.test(text),
            `${path} names @provino/types`,
          )
        }
      }
    }
    walk(join(PACKAGE, 'dist'))
    // The add-ons' own declarations hold `interface DialectRegistry {` inside an augmentation (indented).
    assert.deepEqual(Object.fromEntries(counts), {
      DialectRegistry: 1,
      PluginRegistry: 1,
      ProvidedContext: 1,
    })
  })
})
