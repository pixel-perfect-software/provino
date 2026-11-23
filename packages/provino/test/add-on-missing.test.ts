// B27f (D187): the dialects are add-on installs. A copy of the built package whose `node_modules`
// holds every dependency but the add-ons is `provino` installed alone: `provino jest`,
// `provino vitest` and a config that names the Jest dialect each end as one line with the install
// command, exit 1, no stack, and a native project still runs (the control). Then the add-on found
// from the project and held to this `provino`: another version, another `provino` copy (two
// engines), no `provino` peer at all, and two overlapping `run()` calls on different projects.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  childEnv,
  copyBuiltPackage,
  linkDependencies,
  linkProvino,
  packageCopy,
  runBuilt,
  scratch,
  withoutNodeNoise,
} from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** This package's version: the one the install line pins the add-on to. */
const VERSION = (
  JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { version: string }
).version

/** Writes `files` (with a `package.json` of `type: module`) into `dir`. */
function writeProject(dir: string, files: Readonly<Record<string, string>>): string {
  for (const [name, text] of Object.entries({ 'package.json': '{"type":"module"}\n', ...files })) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

/** A project of `files` with `node_modules/provino` linked to `pkg`. */
function project(pkg: string, files: Readonly<Record<string, string>>): string {
  const dir = writeProject(scratch('provino-alone-project-'), files)
  linkProvino(dir, pkg)
  return dir
}

/** `pkg`'s built bin in `cwd`, stderr without Node's own warnings (Node 22.15's type stripping). */
function bin(pkg: string, cwd: string, args: readonly string[]) {
  const run = runBuilt(args, { cwd, bin: join(pkg, 'dist', 'cli.js'), env: { CI: '1' } })
  return { ...run, stderr: withoutNodeNoise(run.stderr) }
}

const JEST_LINE = `Provino: the jest dialect needs @provino/dialect-jest, which is not installed: pnpm add -D @provino/dialect-jest@${VERSION}\n`
const VITEST_LINE = `Provino: the vitest dialect needs @provino/dialect-vitest, which is not installed: pnpm add -D @provino/dialect-vitest@${VERSION}\n`
const jestTest = "test('adds', () => { expect(1 + 1).toBe(2) })\n"

describe('provino installed without an add-on (B27f, D187)', () => {
  // The copy is made by the first test that needs it, not as the file loads (a listing imports it).
  let copy: string | undefined
  const alone = (): string => {
    copy ??= packageCopy('without-add-ons')
    return copy
  }

  test('provino jest prints the install line, exit 1, no stack', () => {
    const pkg = alone()
    const run = bin(pkg, project(pkg, { 'a.test.js': jestTest }), ['jest', '--ci'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
  })

  test('a jest.config with bare provino is the same line', () => {
    const pkg = alone()
    const run = bin(pkg, project(pkg, { 'jest.config.json': '{}\n', 'a.test.js': jestTest }), [])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
  })

  test('provino vitest prints the install line, exit 1, no stack', () => {
    const pkg = alone()
    const run = bin(pkg, project(pkg, { 'vitest.config.json': '{}\n' }), ['vitest', 'run'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, VITEST_LINE)
  })

  test('bare provino on a vite.config with no Vitest add-on: no config, exit 2, and the pinned install hint', () => {
    const pkg = alone()
    // Whatever the file says (a `test` key, or a plugin option named `test`), only the add-on can
    // read it: the walk's own error, with one line on how to let it.
    const hint = `a vite.config.* was found, and whether it declares tests takes the Vitest dialect to read: pnpm add -D @provino/dialect-vitest@${VERSION}`
    for (const config of [
      "export default { test: { include: ['*.test.ts'] } }\n",
      'export default { plugins: [{ test: /\\.svg$/ }] }\n',
    ]) {
      const run = bin(pkg, project(pkg, { 'vite.config.ts': config }), [])
      assert.equal(run.status, 2, run.stderr)
      assert.match(run.stderr, /found no provino\.config\.\*, Jest config or Vitest config/)
      assert.ok(run.stderr.includes(hint), run.stderr)
      assert.doesNotMatch(run.stderr, /\n\s+at /)
    }
  })

  test("a provino.config that names dialect: 'jest' is the Jest line, exit 1", () => {
    const pkg = alone()
    const dir = project(pkg, {
      'provino.config.ts': "export default { dialect: 'jest', include: ['*.test.js'] }\n",
      'a.test.js': jestTest,
    })
    const run = bin(pkg, dir, ['run'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(run.stderr, JEST_LINE)
  })

  test("a config that imports provino/jest is the Jest line, exit 1 (Node's ERR_MODULE_NOT_FOUND mapped)", () => {
    const pkg = alone()
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
    const pkg = alone()
    const run = bin(
      pkg,
      project(pkg, { 'provino.config.ts': "export default { inclde: ['*.test.ts'] }\n" }),
      ['run'],
    )
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, /inclde/)
    assert.doesNotMatch(run.stderr, /dialect-jest/)
  })

  test("dialect: 'vitest' in a provino config is the config's refusal, not the Jest line", () => {
    const pkg = alone()
    const run = bin(
      pkg,
      project(pkg, { 'provino.config.ts': "export default { dialect: 'vitest' }\n" }),
      ['run'],
    )
    assert.notEqual(run.status, 0, run.stderr)
    assert.doesNotMatch(run.stderr, /dialect-jest/)
    assert.match(run.stderr, /vitest/)
  })

  test('an add-on of another version is refused before it links: one line, the pinned install, exit 1', () => {
    const pkg = alone()
    // A stand-in add-on in the project (its version not provino's) that would fail if it loaded.
    // provino is outside the project, so finding it at all is the project-root resolution.
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
    const pkg = alone()
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

describe("the add-on's provino is the one running (B27f, D187)", () => {
  // Two same-version copies of the built provino, as a global install (or `pnpm dlx`) beside the
  // project's own: `root/proj` has its own `provino` and the Jest add-on (whose peer is that copy),
  // `root/global` the other. Third-party packages are linked at `root`, so both copies and the
  // add-on find them by walking up.
  // Built by the first test that needs it, not as the file loads (a listing imports it).
  let built:
    | { root: string; dialect: string; own: string; global: string; proj: string }
    | undefined
  const copies = (): NonNullable<typeof built> => {
    if (built !== undefined) return built
    const root = scratch('provino-two-copies-')
    linkDependencies(PACKAGE, root, ['@provino'])
    const dialect = realpathSync(join(PACKAGE, 'node_modules', '@provino', 'dialect-jest'))
    linkDependencies(dialect, root, ['@provino', 'provino'])
    const own = copyBuiltPackage(join(root, 'proj', 'node_modules', 'provino'))
    const addOn = join(root, 'proj', 'node_modules', '@provino', 'dialect-jest')
    copyBuiltPackage(addOn, dialect)
    const global = copyBuiltPackage(join(root, 'global', 'node_modules', 'provino'))
    const proj = writeProject(join(root, 'proj'), {
      'a.test.js': jestTest,
      'b.test.js': "test('equal', () => { expect({ a: 1 }).toEqual({ a: 1 }) })\n",
    })
    built = { root, dialect, own, global, proj }
    return built
  }

  test("the project's own provino runs it (the control)", () => {
    const { own, proj } = copies()
    const run = bin(own, proj, ['jest', '--ci'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /Tests:\s+2 passed, 2 total/)
  })

  test('another copy is refused before the add-on links: one line naming both, exit 1', () => {
    const { global, own, proj } = copies()
    const run = bin(global, proj, ['jest', '--ci'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(
      run.stderr,
      `Provino: @provino/dialect-jest runs on the provino in ${own}, not this one in ${global}: run the project's own (pnpm exec provino …)\n`,
    )
  })

  test('an add-on with no provino peer installed is one line too', () => {
    const { root, dialect } = copies()
    // The project's provino removed: the add-on's `provino/internal/*` imports would find none.
    const bare = scratch('provino-no-peer-')
    linkDependencies(root, bare)
    const lonely = join(bare, 'proj', 'node_modules', '@provino', 'dialect-jest')
    copyBuiltPackage(lonely, dialect)
    const where = writeProject(join(bare, 'proj'), { 'a.test.js': jestTest })
    const other = copyBuiltPackage(join(bare, 'global', 'node_modules', 'provino'))
    const run = bin(other, where, ['jest', '--ci'])
    assert.equal(run.status, 1, run.stderr)
    assert.equal(
      run.stderr,
      `Provino: @provino/dialect-jest is installed without its provino peer: pnpm add -D provino@${VERSION}\n`,
    )
  })
})

describe('run() calls that overlap on different projects (B27f, D187)', () => {
  test("each resolves its own project's add-on", () => {
    // provino installed alone, and two projects: one with a stand-in add-on of another version, one
    // with none. Both run at once in one process: each gets its own project's answer.
    const pkg = packageCopy('without-add-ons')
    const config = "export default { dialect: 'jest', include: ['*.test.js'] }\n"
    const old = project(pkg, {
      'provino.config.ts': config,
      'a.test.js': jestTest,
      'node_modules/@provino/dialect-jest/package.json': JSON.stringify({
        name: '@provino/dialect-jest',
        version: '0.0.1',
        type: 'module',
        exports: { '.': { import: './index.js' } },
      }),
      'node_modules/@provino/dialect-jest/index.js': "throw new Error('the old add-on loaded')\n",
    })
    const none = project(pkg, { 'provino.config.ts': config, 'a.test.js': jestTest })
    const node = pathToFileURL(join(pkg, 'dist', 'node.js')).href
    const script = [
      `const { run } = await import(${JSON.stringify(node)})`,
      'const out = (cwd) => { let text = ""; return { write: (t) => { text += t; return true }, text: () => text } }',
      `const a = out(), b = out()`,
      `const [ra, rb] = await Promise.all([`,
      `  run({ config: 'provino.config.ts', cwd: ${JSON.stringify(old)}, stderr: a, stdout: a }),`,
      `  run({ config: 'provino.config.ts', cwd: ${JSON.stringify(none)}, stderr: b, stdout: b }),`,
      `])`,
      'console.log(JSON.stringify([ra.exitCode, a.text(), rb.exitCode, b.text()]))',
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkg,
      encoding: 'utf8',
      env: childEnv([], { CI: '1' }),
      timeout: 60_000,
    })
    assert.equal(result.status, 0, result.stderr)
    const [codeA, textA, codeB, textB] = JSON.parse(result.stdout) as [
      number,
      string,
      number,
      string,
    ]
    assert.equal(codeA, 1)
    assert.equal(
      withoutNodeNoise(textA),
      `Provino: @provino/dialect-jest 0.0.1 is installed, but provino is ${VERSION}: pnpm add -D @provino/dialect-jest@${VERSION}\n`,
    )
    assert.equal(codeB, 1)
    assert.equal(withoutNodeNoise(textB), JEST_LINE)
  })
})
