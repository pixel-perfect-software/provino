// What a package needs, beside its rewritten test files, to run them on Provino (B27g2, D203):
// the config, the tests' tsconfig project, its turbo.json, the tsconfig exclude and the root
// reference, and the `test` script. Idempotent: it writes what is missing and sets the script, so
// running `rewrite` again after editing `bootstrap.json` refreshes the script. Left to hand: the
// bootstrap entries themselves, and a `test/` directory's own tsconfig (a reference to
// `../../provino` when its tests import `provino`).
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { testScript } from '../dogfood.ts'
import { MigrateError } from './errors.ts'

const CONFIG = `import { packageConfig } from '../../tooling/provino/base.ts'

export default packageConfig(import.meta.dirname)
`

const TESTS_TSCONFIG = {
  extends: '../../tsconfig.base.json',
  include: ['src/**/*.test.ts'],
  references: [{ path: './tsconfig.json' }, { path: '../provino' }, { path: '../types' }],
}

const TURBO = {
  $schema: '../../node_modules/turbo/schema.json',
  extends: ['//'],
  tasks: {
    test: {
      dependsOn: ['transit', 'provino#build'],
      inputs: [
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/tooling/provino/**',
        '$TURBO_ROOT$/tooling/packaging/src/dogfood.ts',
      ],
    },
  },
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (cause) {
    throw new MigrateError(
      'MIGRATE_WRITE',
      `cannot read ${path} as JSON (comments in it? edit by hand)`,
      {
        cause,
      },
    )
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

async function writeIfMissing(path: string, text: string, written: string[]): Promise<void> {
  if (existsSync(path)) return
  await writeFile(path, text)
  written.push(path)
}

async function updateJson(
  path: string,
  change: (value: Record<string, unknown>) => boolean,
  written: string[],
): Promise<void> {
  const value = await readJson(path)
  if (change(value)) {
    await writeFile(path, json(value))
    written.push(path)
  }
}

/**
 * Scaffolds the package at `packageDir` under `root`; returns the files it wrote.
 * @internal
 */
export async function scaffoldPackage(
  root: string,
  packageDir: string,
): Promise<readonly string[]> {
  const dir = relative(root, packageDir).split('\\').join('/')
  if (dir.startsWith('..')) return []
  const written: string[] = []
  await writeIfMissing(join(packageDir, 'provino.config.ts'), CONFIG, written)
  await writeIfMissing(join(packageDir, 'tsconfig.tests.json'), json(TESTS_TSCONFIG), written)
  await writeIfMissing(join(packageDir, 'turbo.json'), json(TURBO), written)
  await updateJson(
    join(packageDir, 'tsconfig.json'),
    (config) => {
      if (config.exclude !== undefined) return false
      config.exclude = ['src/**/*.test.ts']
      return true
    },
    written,
  )
  await updateJson(
    join(root, 'tsconfig.json'),
    (config) => {
      const references = (config.references ?? []) as { path: string }[]
      const tests = `${dir}/tsconfig.tests.json`
      if (references.some((reference) => reference.path === tests)) return false
      const at = references.findIndex((reference) => reference.path === dir)
      references.splice(at < 0 ? references.length : at + 1, 0, { path: tests })
      config.references = references
      return true
    },
    written,
  )
  await updateJson(
    join(packageDir, 'package.json'),
    (manifest) => {
      const scripts = (manifest.scripts ?? {}) as Record<string, string>
      const script = testScript(root, dir)
      if (scripts.test === script) return false
      manifest.scripts = { ...scripts, test: script }
      return true
    },
    written,
  )
  return written
}
