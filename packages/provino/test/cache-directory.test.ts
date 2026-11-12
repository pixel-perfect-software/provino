// D70: where Provino's caches live. By default `<rootDir>/node_modules/.cache/provino`; when the
// Jest config sets `cacheDirectory` itself (CI setups cache that directory between runs), under
// `<cacheDirectory>/provino`, and `--clearCache` clears whichever applies. Jest's own `/tmp/jest_*`
// default is never used.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'

const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: { stdout: Writable; stderr: Writable; cwd: string },
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

async function project(config: Record<string, unknown>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-cache-dir-')))
  made.push(dir)
  const files: Record<string, string> = {
    'package.json': '{"type":"commonjs"}\n',
    'jest.config.json': JSON.stringify(config),
    'a.test.js': "test('a', () => { expect(1).toBe(1) })\n",
    'b.test.js': "test('b', () => { expect(2).toBe(2) })\n",
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function files(path: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) out.push(...(await files(full)))
    else out.push(full)
  }
  return out
}

async function command(
  dir: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Sink()
  const stderr = new Sink()
  const code = await runJestCommand(['--ci', ...args], { stdout, stderr, cwd: dir })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

describe('where the caches live (D70)', () => {
  it('an explicit cacheDirectory gets the results and transform caches, the default location none', async () => {
    const dir = await project({ cacheDirectory: '<rootDir>/.ci-cache' })
    const ran = await command(dir, [])
    assert.equal(ran.code, 0, ran.stderr)
    const cache = join(dir, '.ci-cache', 'provino')
    assert.ok(await exists(join(cache, 'results.json')), 'the results cache is there')
    assert.ok((await files(join(cache, 't'))).length > 0, 'the transform cache is there')
    assert.equal(await exists(join(dir, 'node_modules', '.cache', 'provino')), false)
  })

  it('without one, the default location gets them and an unset cacheDirectory is not Jest’s /tmp one', async () => {
    const dir = await project({})
    const ran = await command(dir, [])
    assert.equal(ran.code, 0, ran.stderr)
    const cache = join(dir, 'node_modules', '.cache', 'provino')
    assert.ok(await exists(join(cache, 'results.json')))
    assert.ok((await files(join(cache, 't'))).length > 0)
  })

  it('a second run reads the explicit directory back (the results cache is warm)', async () => {
    const dir = await project({ cacheDirectory: '<rootDir>/.ci-cache' })
    await command(dir, [])
    const before = await files(join(dir, '.ci-cache', 'provino', 't'))
    const again = await command(dir, [])
    assert.equal(again.code, 0, again.stderr)
    assert.deepEqual(await files(join(dir, '.ci-cache', 'provino', 't')), before)
  })

  it('--clearCache empties the explicit directory’s provino caches and says where', async () => {
    const dir = await project({ cacheDirectory: '<rootDir>/.ci-cache' })
    await command(dir, [])
    const cache = join(dir, '.ci-cache', 'provino')
    assert.ok(await exists(cache))
    // Another tool's files in the shared directory stay.
    await writeFile(join(dir, '.ci-cache', 'jest-haste-map'), 'x')
    const cleared = await command(dir, ['--clearCache'])
    assert.equal(cleared.code, 0, cleared.stderr)
    assert.equal(cleared.stdout, `Cleared ${cache}\n`)
    assert.equal(await exists(cache), false)
    assert.ok(await exists(join(dir, '.ci-cache', 'jest-haste-map')))
  })

  it('--clearCache without cacheDirectory clears the default location', async () => {
    const dir = await project({})
    await command(dir, [])
    const cache = join(dir, 'node_modules', '.cache', 'provino')
    assert.ok(await exists(cache))
    const cleared = await command(dir, ['--clearCache'])
    assert.equal(cleared.stdout, `Cleared ${cache}\n`)
    assert.equal(await exists(cache), false)
  })

  it('--no-cache writes nothing to the explicit directory', async () => {
    const dir = await project({ cacheDirectory: '<rootDir>/.ci-cache' })
    const ran = await command(dir, ['--no-cache'])
    assert.equal(ran.code, 0, ran.stderr)
    assert.equal(await exists(join(dir, '.ci-cache', 'provino')), false)
  })
})
