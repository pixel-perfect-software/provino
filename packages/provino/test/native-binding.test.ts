// T10.3's Provino half, on the built bin: with an Oxc native binding missing, `--version` and
// `--help` still answer (they load nothing native), and a run ends as one message that names this
// platform's binding packages, exit 1, no stack. The missing binding is a `require` hook
// (`block-oxc-bindings.ts`), so it is the install that is wrong and nothing else: `pnpm
// smoke:install` does the same by deleting the packages from a real tarball install.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(PACKAGE, 'dist', 'cli.js')
const BLOCKER = fileURLToPath(new URL('./block-oxc-bindings.ts', import.meta.url))
const RECORDER = fileURLToPath(new URL('./load-recorder.ts', import.meta.url))
/**
 * This machine's Oxc binding suffix, worked out here and not by the code under test (this project
 * has no `src/`, so it cannot import it): `darwin-arm64`, `linux-x64-gnu`, `win32-x64-msvc`.
 */
function platformTriple(): string {
  const { platform, arch } = process
  if (platform === 'win32') return `win32-${arch}-msvc`
  if (platform !== 'linux') return `${platform}-${arch}`
  const header = (process.report.getReport() as { header: object }).header
  return `linux-${arch}-${'glibcVersionRuntime' in header ? 'gnu' : 'musl'}`
}

const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  readonly version: string
}

function run(args: readonly string[], preloads: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const imports = preloads.map((file) => `--import=${file}`).join(' ')
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: realpathSync(mkdtempSync(join(tmpdir(), 'provino-binding-'))),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${imports}`.trim(),
    },
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('a missing Oxc binding (T10.3)', () => {
  test('--version and --help answer without loading any Oxc package', () => {
    const logs = mkdtempSync(join(tmpdir(), 'provino-loads-'))
    for (const args of [['--version'], ['--help'], ['-h']]) {
      const result = run(args, [RECORDER], { PROVINO_LOAD_LOG: logs })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr.replace(/^ERROR: failed to copy trust.*\n/gm, ''), '')
      assert.ok(
        args[0] === '--version'
          ? result.stdout === `${manifest.version}\n`
          : result.stdout.startsWith('Usage: provino <command> [options]'),
        result.stdout,
      )
    }
    const loaded = readdirSync(logs).flatMap((file) =>
      readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean),
    )
    assert.ok(loaded.length > 0)
    assert.ok(
      loaded.every((line) => !/oxc|\/shared\.js|\/coordinator\.js/.test(line.split('\t')[1] ?? '')),
      loaded.join('\n'),
    )
  })

  test('--version and --help still answer when the bindings are missing', () => {
    for (const args of [['--version'], ['--help']]) {
      const result = run(args, [BLOCKER])
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.length > 0)
    }
  })

  test("a run ends with one message naming this platform's three binding packages, exit 1, no stack", () => {
    const triple = platformTriple()
    for (const args of [['jest', '--ci'], ['run', '--config', 'provino.config.mjs'], []]) {
      const result = run(args, [BLOCKER])
      const stderr = result.stderr.replace(/^ERROR: failed to copy trust.*\n/gm, '')
      assert.equal(result.status, 1, `${args.join(' ')}: ${stderr}`)
      assert.equal(result.stdout, '')
      for (const name of ['parser', 'transform', 'resolver']) {
        assert.ok(stderr.includes(`@oxc-${name}/binding-${triple}`), `${name}: ${stderr}`)
      }
      assert.equal(stderr.match(/^Provino: /gm)?.length, 1, stderr)
      assert.doesNotMatch(
        stderr,
        /\n\s+at |file:\/\/|Cannot find native binding|node:internal/,
        stderr,
      )
    }
  })

  test('with the bindings installed the same commands run as before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provino-binding-ok-'))
    mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}\n')
    writeFileSync(join(dir, 'tests', 'a.test.js'), "test('a', () => { expect(1).toBe(1) })\n")
    const result = spawnSync(process.execPath, [BIN, 'jest', '--ci'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /Tests:\s+1 passed, 1 total/)
  })
})
