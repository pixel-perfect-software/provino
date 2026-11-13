// T10.3's Provino half, on the built bin: with an Oxc native binding missing, `--version` and
// `--help` still answer (they load nothing native), and a run ends as one message that names this
// platform's binding packages, exit 1, no stack. The missing binding is a `require` hook
// (`block-oxc-bindings.ts`), so it is the install that is wrong and nothing else: `pnpm
// smoke:install` does the same by deleting the packages from a real tarball install.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runBuilt, trackedProjects } from './support.ts'

/** `bindingTriple`, loaded by URL: the type-test project includes this directory but not the package's source. */
const { bindingTriple } = (await import(
  new URL('../src/internal/native-binding.ts', import.meta.url).href
)) as { bindingTriple(platform: string, arch: string, musl: boolean): string }

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  readonly version: string
}

/** This machine's Oxc binding suffix, as the code under test names it. */
function platformTriple(): string {
  const header = (process.report.getReport() as { header: object }).header
  return bindingTriple(
    process.platform,
    process.arch,
    process.platform === 'linux' && !('glibcVersionRuntime' in header),
  )
}

const project = trackedProjects()

describe('a missing Oxc binding (T10.3)', () => {
  test('--version and --help answer without loading any Oxc package', async () => {
    const { dir } = await project({})
    const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
    after(() => rm(logs, { recursive: true, force: true }))
    for (const args of [['--version'], ['--help'], ['-h']]) {
      const result = runBuilt(args, {
        cwd: dir,
        preloads: ['load-recorder'],
        env: { PROVINO_LOAD_LOG: logs },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
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

  test('--version and --help still answer when the bindings are missing', async () => {
    const { dir } = await project({})
    for (const args of [['--version'], ['--help']]) {
      const result = runBuilt(args, { cwd: dir, preloads: ['block-oxc-bindings'] })
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.length > 0)
    }
  })

  test("a run ends with one message naming this platform's three binding packages, exit 1, no stack", async () => {
    const { dir } = await project({})
    const triple = platformTriple()
    for (const args of [['jest', '--ci'], ['run', '--config', 'provino.config.mjs'], []]) {
      const result = runBuilt(args, { cwd: dir, preloads: ['block-oxc-bindings'] })
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`)
      assert.equal(result.stdout, '')
      for (const name of ['parser', 'transform', 'resolver']) {
        assert.ok(
          result.stderr.includes(`@oxc-${name}/binding-${triple}`),
          `${name}: ${result.stderr}`,
        )
      }
      assert.equal(result.stderr.match(/^Provino: /gm)?.length, 1, result.stderr)
      assert.doesNotMatch(
        result.stderr,
        /\n\s+at |file:\/\/|Cannot find native binding|node:internal/,
        result.stderr,
      )
    }
  })

  test("another package's missing binding is not reported as an Oxc one: the error and its stack come through", async () => {
    const { dir } = await project({})
    const result = runBuilt(['jest', '--ci'], {
      cwd: dir,
      preloads: ['block-oxc-bindings'],
      env: { PROVINO_BLOCK: 'other' },
    })
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stderr, /^Provino: the native Oxc binding/m)
    assert.match(result.stderr, /Cannot find native binding/)
    assert.match(result.stderr, /@swc\/core-darwin-arm64/)
    // Node's own uncaught-error report, with the stack that points at where it came from.
    assert.match(result.stderr, /\n\s+at /)
  })

  test('with the bindings installed the same commands run as before', async () => {
    const { dir } = await project({
      'tests/a.test.js': "test('a', () => { expect(1).toBe(1) })\n",
    })
    const result = runBuilt(['jest', '--ci'], { cwd: dir })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /Tests:\s+1 passed, 1 total/)
  })
})
