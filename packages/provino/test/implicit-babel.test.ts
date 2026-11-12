// D68, end to end: a Jest project that names no `transform` gets Jest's implicit `babel-jest`. With a
// Babel config, Provino runs the real babel-jest, so a plugin's effect is seen by the tests and
// every test's status equals real Jest 30.5.2's, run here on the same temp tree. Without one it
// stays on the Oxc path (babel-jest would only hoist). The temp project has only `jest` in its
// `node_modules` (a link), as a pnpm project does: `babel-jest` is not resolvable from its root,
// only from the `jest-config` that `jest` leads to, which is where Jest's own default finds it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { viewOfNormalized } from './support.ts'

const TRANSFORM_PACKAGE: string = fileURLToPath(new URL('../../transform/', import.meta.url))
const requireFromTransform = createRequire(join(TRANSFORM_PACKAGE, 'x.js'))
const JEST: string = requireFromTransform.resolve('jest/bin/jest')
const JEST_PACKAGE: string = dirname(requireFromTransform.resolve('jest/package.json'))

const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: {
      stdout: Writable
      stderr: Writable
      cwd: string
      reporters: readonly (readonly ['normalized-json', { outputFile: string }])[]
    },
  ): Promise<number>
}

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** A plugin that replaces the identifier `MARKER` with the string its options give. */
const PLUGIN = `module.exports = ({ types: t }, options) => ({
  visitor: {
    Identifier(path) {
      if (path.node.name === 'MARKER' && path.isReferencedIdentifier()) {
        path.replaceWith(t.stringLiteral(options.to))
      }
    },
  },
})
`

const babelConfig = (to: string): string =>
  `module.exports = { plugins: [['./marker-plugin.cjs', { to: '${to}' }]] }\n`

const TESTS = `test('sees the plugin', () => { expect(MARKER).toBe('on') })
test('plain', () => { expect(1 + 1).toBe(2) })
test.skip('later', () => {})
`

async function project(withBabel: boolean, below = false): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-implicit-babel-')))
  made.push(dir)
  const files: Record<string, string> = {
    'package.json': '{"type":"commonjs"}\n',
    'jest.config.json': '{}\n',
    [below ? 'src/a.test.js' : 'a.test.js']: TESTS,
    ...(below
      ? {
          'src/.babelrc': '{"plugins":[["../marker-plugin.cjs",{"to":"on"}]]}\n',
          'marker-plugin.cjs': PLUGIN,
        }
      : {}),
    ...(withBabel && !below
      ? { 'babel.config.js': babelConfig('on'), 'marker-plugin.cjs': PLUGIN }
      : {}),
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  await mkdir(join(dir, 'node_modules'))
  await symlink(JEST_PACKAGE, join(dir, 'node_modules', 'jest'))
  return dir
}

async function jestStatuses(dir: string): Promise<ReadonlyMap<string, string>> {
  const out = join(dir, '.out-jest.json')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, '--no-cache', '--ci', '--json', `--outputFile=${out}`],
      { cwd: dir, stdio: 'ignore' },
    )
    child.once('error', reject)
    child.once('close', () => resolve())
  })
  const report = JSON.parse(await readFile(out, 'utf8')) as {
    testResults: { assertionResults: { fullName: string; status: string }[] }[]
  }
  const statuses = new Map<string, string>()
  for (const file of report.testResults) {
    for (const test of file.assertionResults) statuses.set(test.fullName, test.status)
  }
  return statuses
}

async function provinoStatuses(
  dir: string,
  cache = false,
): Promise<{ code: number; statuses: ReadonlyMap<string, string>; stderr: string }> {
  const out = join(dir, '.out-provino.json')
  const stderr = new Sink()
  const here = process.cwd()
  process.chdir(dir)
  try {
    const code = await runJestCommand(['--ci', ...(cache ? [] : ['--no-cache'])], {
      stdout: new Sink(),
      stderr,
      cwd: dir,
      reporters: [['normalized-json', { outputFile: out }]],
    })
    const view = viewOfNormalized(await readFile(out, 'utf8'))
    const statuses = new Map<string, string>()
    const jestWord: Readonly<Record<string, string>> = { skipped: 'pending' }
    for (const file of view.files.values()) {
      for (const [path, status] of file.tests) {
        statuses.set(path.replaceAll(' > ', ' '), jestWord[String(status)] ?? String(status))
      }
    }
    return { code, statuses, stderr: stderr.text }
  } finally {
    process.chdir(here)
  }
}

const sorted = (map: ReadonlyMap<string, string>): [string, string][] =>
  [...map].sort(([a], [b]) => (a < b ? -1 : 1))

describe("Jest's implicit babel-jest (D68)", () => {
  it('with a Babel config, runs the real babel-jest: statuses equal real Jest', async () => {
    const dir = await project(true)
    const expected = await jestStatuses(dir)
    assert.equal(expected.get('sees the plugin'), 'passed', 'real Jest applies the plugin')
    const ran = await provinoStatuses(dir)
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(sorted(ran.statuses), sorted(expected))
  })

  it('a .babelrc below the root, in the root package, applies: statuses equal real Jest', async () => {
    const dir = await project(false, true)
    const expected = await jestStatuses(dir)
    assert.equal(expected.get('sees the plugin'), 'passed', 'real Jest applies src/.babelrc')
    const ran = await provinoStatuses(dir)
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(sorted(ran.statuses), sorted(expected))
  })

  it('without a Babel config, stays on the Oxc path (no plugin, and the same statuses as Jest)', async () => {
    const dir = await project(false)
    const expected = await jestStatuses(dir)
    assert.equal(expected.get('sees the plugin'), 'failed', 'real Jest has no plugin either')
    const ran = await provinoStatuses(dir)
    assert.equal(ran.code, 1)
    assert.deepEqual(sorted(ran.statuses), sorted(expected))
    // The Oxc path starts no babel-jest: nothing in the project's own transform cache is Babel's.
    assert.doesNotMatch(ran.stderr, /babel/i)
  })

  it('editing the Babel config misses the transform cache', async () => {
    const dir = await project(true)
    const first = await provinoStatuses(dir, true)
    assert.equal(first.statuses.get('sees the plugin'), 'passed', first.stderr)
    const warm = await provinoStatuses(dir, true)
    assert.equal(warm.statuses.get('sees the plugin'), 'passed', warm.stderr)
    await writeFile(join(dir, 'babel.config.js'), babelConfig('off'))
    const edited = await provinoStatuses(dir, true)
    assert.equal(
      edited.statuses.get('sees the plugin'),
      'failed',
      'the old transform was not reused',
    )
  })
})
