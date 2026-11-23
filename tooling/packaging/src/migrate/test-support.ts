// Helpers for the migrate tests. Not a test file: the runner discovers only `*.test.ts`.
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scratchDir } from '../test-support.ts'

/**
 * A runner that writes the report it is told to (the `--outputFile` of its command line), listing
 * `tests` as `[title path joined with ' > ', Provino status]` under `src/a.test.ts`; with `echo`
 * the config it was given comes back as one more test, named by the config's text.
 */
export async function fakeRunner(
  dir: string,
  tests: readonly (readonly [string, string])[],
  echo = false,
): Promise<string> {
  const path = join(dir, 'runner.ts')
  const report = {
    files: [
      {
        file: 'src/a.test.ts',
        status: 'passed',
        tests: tests.map(([name, status]) => ({ id: { path: name.split(' > ') }, status })),
      },
    ],
  }
  await writeFile(
    path,
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const arg = (name: string): string => process.argv[process.argv.indexOf(name) + 1] ?? ''",
      "const config = readFileSync(arg('--config'), 'utf8')",
      `const report = ${JSON.stringify(report)}`,
      `if (${echo}) report.files[0]?.tests.push({ id: { path: ['config', config] }, status: 'passed' })`,
      "writeFileSync(arg('--outputFile'), JSON.stringify(report))",
      '',
    ].join('\n'),
  )
  return path
}

/**
 * A scratch workspace holding one package, `pkg`, whose test script runs `src/**`'s tests. Its
 * paths are real paths (node:test reports those), and `cache` is where baselines go.
 */
export async function fixturePackage(
  files: Readonly<Record<string, string>>,
): Promise<{ root: string; pkg: string; cache: string }> {
  const root = await realpath(
    scratchDir('migrate', {
      'pkg/package.json': JSON.stringify({
        name: 'fixture',
        type: 'module',
        scripts: { test: 'node --test "src/**/*.test.ts"' },
      }),
      ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`pkg/${name}`, text])),
    }),
  )
  return { root, pkg: join(root, 'pkg'), cache: join(root, 'cache') }
}

/** A three-test file: one passes, one is skipped, one fails. */
export const THREE_TESTS: string = [
  "import assert from 'node:assert/strict'",
  "import { describe, it } from 'node:test'",
  "describe('suite', () => {",
  "  it('passes', () => { assert.ok(true) })",
  "  it('skipped', { skip: true }, () => {})",
  "  it('fails', () => { assert.equal(1, 2) })",
  '})',
  '',
].join('\n')

/** What Provino would report for `THREE_TESTS`, with each test's status overridable by name. */
export const THREE_REPORT: readonly (readonly [string, string])[] = [
  ['suite > passes', 'passed'],
  ['suite > skipped', 'skipped'],
  ['suite > fails', 'failed'],
]
