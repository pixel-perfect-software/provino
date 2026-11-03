import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { resolveRunnerPackage } from './runner-package.ts'

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')

test('it finds the installed Jest and Vitest from a directory, with a bin that is a real file', async () => {
  for (const name of ['jest', 'vitest']) {
    const found = resolveRunnerPackage(name, PACKAGE_DIR)
    assert.match(found.version, /^\d+\.\d+\.\d+/, name)
    assert.ok(path.isAbsolute(found.bin), name)
    assert.ok(found.bin.endsWith(found.binInPackage), name)
    await access(found.bin)
  }
})

test('the anchor can be a directory, a URL or the text of a file URL', () => {
  const fromDir = resolveRunnerPackage('jest', PACKAGE_DIR)
  assert.deepEqual(resolveRunnerPackage('jest', new URL(import.meta.url)), fromDir)
  assert.deepEqual(resolveRunnerPackage('jest', import.meta.url), fromDir)
  assert.deepEqual(resolveRunnerPackage('jest', path.join(PACKAGE_DIR, 'src')), fromDir)
})

async function withPackage(
  manifest: Record<string, unknown>,
  use: (dir: string, real: string) => void,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-runner-'))
  try {
    await mkdir(path.join(dir, 'node_modules', 'tool'), { recursive: true })
    await writeFile(
      path.join(dir, 'node_modules', 'tool', 'package.json'),
      JSON.stringify(manifest),
    )
    use(dir, await realpath(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function failed(...mentions: string[]): (error: unknown) => boolean {
  return (error) =>
    error instanceof HarnessError &&
    error.code === 'HARNESS_RUNNER_FAILED' &&
    mentions.every((text) => error.message.includes(text))
}

test('a bin given as a string, or as an object keyed by the package name', async () => {
  await withPackage({ version: '1.2.3', bin: 'bin/tool.js' }, (dir, real) => {
    assert.deepEqual(resolveRunnerPackage('tool', dir), {
      version: '1.2.3',
      bin: path.join(real, 'node_modules', 'tool', 'bin', 'tool.js'),
      binInPackage: path.join('bin', 'tool.js'),
    })
  })
  await withPackage({ version: '1.2.3', bin: { other: 'o.js', tool: './t.js' } }, (dir, real) => {
    const found = resolveRunnerPackage('tool', dir)
    assert.equal(found.bin, path.join(real, 'node_modules', 'tool', 't.js'))
    assert.equal(found.binInPackage, 't.js')
  })
})

test('a package that is not installed, or has no version or no bin of its name, is a coded error', async () => {
  await withPackage({ version: '1.2.3', bin: 'bin/tool.js' }, (dir) => {
    assert.throws(() => resolveRunnerPackage('absent', dir), failed('absent', 'not installed'))
  })
  await withPackage({ bin: 'bin/tool.js' }, (dir) => {
    assert.throws(() => resolveRunnerPackage('tool', dir), failed('no version'))
  })
  await withPackage({ version: '1.2.3', bin: { other: 'o.js' } }, (dir) => {
    assert.throws(() => resolveRunnerPackage('tool', dir), failed('no "tool" bin'))
  })
  await withPackage({ version: '1.2.3' }, (dir) => {
    assert.throws(() => resolveRunnerPackage('tool', dir), failed('no "tool" bin'))
  })
})
