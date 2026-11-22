// B27f (D187): the dialects are add-on installs. A copy of the built package whose `node_modules`
// holds every dependency but the two add-ons is `provino` installed alone: `provino jest`,
// `provino vitest` and a config that names the Jest dialect each end as one line with the install
// command, exit 1, no stack, and a native project still runs (the control).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { childEnv } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** The built package with its dependencies linked, the `@provino/*` workspace links left out. */
function provinoAlone(): string {
  const copy = mkdtempSync(join(tmpdir(), 'provino-alone-'))
  after(() => rmSync(copy, { recursive: true, force: true }))
  cpSync(join(PACKAGE, 'dist'), join(copy, 'dist'), { recursive: true })
  cpSync(join(PACKAGE, 'package.json'), join(copy, 'package.json'))
  const modules = join(PACKAGE, 'node_modules')
  mkdirSync(join(copy, 'node_modules'))
  for (const name of readdirSync(modules)) {
    if (name === '@provino' || name === '.bin') continue
    symlinkSync(join(modules, name), join(copy, 'node_modules', name), 'dir')
  }
  return copy
}

/** A project of `files` with `node_modules/provino` linked to `pkg`. */
function project(pkg: string, files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-alone-project-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries({ 'package.json': '{"type":"module"}\n', ...files })) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(pkg, join(dir, 'node_modules', 'provino'), 'dir')
  return dir
}

function bin(pkg: string, cwd: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv([], { CI: '1' }),
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** This package's version: the one the install line pins the add-on to. */
const VERSION = (
  JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { version: string }
).version

const JEST_LINE = `Provino: the jest dialect needs @provino/dialect-jest, which is not installed: pnpm add -D @provino/dialect-jest@${VERSION}\n`
const VITEST_LINE = `Provino: the vitest dialect needs @provino/dialect-vitest, which is not installed: pnpm add -D @provino/dialect-vitest@${VERSION}\n`

describe('provino installed without an add-on (B27f, D187)', () => {
  const pkg = provinoAlone()
  const jestTest = "test('adds', () => { expect(1 + 1).toBe(2) })\n"

  test('provino jest prints the install line, exit 1, no stack', () => {
    const dir = project(pkg, { 'a.test.js': jestTest })
    const run = bin(pkg, dir, ['jest', '--ci'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
    assert.doesNotMatch(run.stderr, /\n\s+at /)
  })

  test('a jest.config with bare provino is the same line', () => {
    const dir = project(pkg, { 'jest.config.json': '{}\n', 'a.test.js': jestTest })
    const run = bin(pkg, dir, [])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
  })

  test('provino vitest prints the install line, exit 1, no stack', () => {
    const dir = project(pkg, { 'vitest.config.json': '{}\n' })
    const run = bin(pkg, dir, ['vitest', 'run'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, VITEST_LINE)
  })

  test('bare provino on a vite.config with a test key is the Vitest line, exit 1; one without is no config', () => {
    const vite = project(pkg, {
      'vite.config.ts': "export default { test: { include: ['*.test.ts'] } }\n",
    })
    const run = bin(pkg, vite, [])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, VITEST_LINE)
    // The control: a vite.config for a bundler only is not a Vitest project, with or without the add-on.
    const bundler = project(pkg, { 'vite.config.ts': 'export default { build: {} }\n' })
    const plain = bin(pkg, bundler, [])
    assert.equal(plain.status, 2, plain.stderr)
    assert.match(plain.stderr, /found no provino\.config\.\*, Jest config or Vitest config/)
  })

  test("a provino.config that names dialect: 'jest' is the Jest line, exit 1", () => {
    const dir = project(pkg, {
      'provino.config.ts': "export default { dialect: 'jest', include: ['*.test.js'] }\n",
      'a.test.js': jestTest,
    })
    const run = bin(pkg, dir, ['run'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
  })

  test("a config that imports provino/jest is the Jest line, exit 1 (Node's ERR_MODULE_NOT_FOUND mapped)", () => {
    const dir = project(pkg, {
      'provino.config.ts':
        "import { jestDialect } from 'provino/jest'\nvoid jestDialect\nexport default { include: ['*.test.js'] }\n",
      'a.test.js': jestTest,
    })
    const run = bin(pkg, dir, ['run'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
  })

  test("a native config with a typo'd key is the config's own error, not the install line", () => {
    const dir = project(pkg, { 'provino.config.ts': "export default { inclde: ['*.test.ts'] }\n" })
    const run = bin(pkg, dir, ['run'])
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, /inclde/)
    assert.doesNotMatch(run.stderr, /dialect-jest/)
  })

  test("dialect: 'vitest' in a provino config is the config's refusal, not the Jest line", () => {
    const dir = project(pkg, { 'provino.config.ts': "export default { dialect: 'vitest' }\n" })
    const run = bin(pkg, dir, ['run'])
    assert.notEqual(run.status, 0, run.stderr)
    assert.doesNotMatch(run.stderr, /dialect-jest/)
    assert.match(run.stderr, /vitest/)
  })

  test('an add-on of another version is refused before it links: one line, the pinned install, exit 1', () => {
    // A stand-in add-on in the project (its version not provino's) that would fail if it loaded.
    const dir = project(pkg, {
      'a.test.js': jestTest,
      'node_modules/@provino/dialect-jest/package.json': JSON.stringify({
        name: '@provino/dialect-jest',
        version: '0.0.1',
        type: 'module',
        exports: { '.': { import: './index.js' }, './node': { import: './index.js' } },
      }),
      'node_modules/@provino/dialect-jest/index.js': "throw new Error('the old add-on loaded')\n",
    })
    const run = bin(pkg, dir, ['jest', '--ci'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(
      run.stderr,
      `Provino: @provino/dialect-jest 0.0.1 is installed, but provino is ${VERSION}: pnpm add -D @provino/dialect-jest@${VERSION}\n`,
    )
  })

  test('the control: a native project runs with no add-on installed', () => {
    const dir = project(pkg, {
      'provino.config.ts': "export default { include: ['*.test.ts'] }\n",
      'a.test.ts':
        "import { expect, test } from 'provino'\ntest('adds', () => { expect(1 + 1).toBe(2) })\n",
    })
    const run = bin(pkg, dir, [])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /Tests:\s+1 passed, 1 total/)
  })
})
