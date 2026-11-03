import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isNotFound } from './guards.ts'
import { isNodeModules, walkFiles } from './walk.ts'

async function withTempDir(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-walk-'))
  try {
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function put(root: string, file: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), '')
}

test('walkFiles lists every file as a sorted POSIX path relative to the root', async () => {
  await withTempDir(async (root) => {
    for (const file of ['b.ts', 'a/z.ts', 'a/b/c.ts', 'a-b.ts', 'Z.ts']) await put(root, file)
    assert.deepEqual(await walkFiles(root), ['Z.ts', 'a-b.ts', 'a/b/c.ts', 'a/z.ts', 'b.ts'])
  })
})

test('skipDir keeps a directory from being entered, and is told its relative path', async () => {
  await withTempDir(async (root) => {
    for (const file of [
      'a.ts',
      'node_modules/x/y.ts',
      'sub/node_modules/z.ts',
      'sub/.cache/c.ts',
    ]) {
      await put(root, file)
    }
    const asked: string[] = []
    const files = await walkFiles(root, {
      skipDir: (dir) => {
        asked.push(dir)
        return isNodeModules(dir)
      },
    })
    assert.deepEqual(files, ['a.ts', 'sub/.cache/c.ts'])
    assert.deepEqual(asked.toSorted(), ['node_modules', 'sub', 'sub/.cache', 'sub/node_modules'])
  })
})

test('keep chooses the files, by relative path', async () => {
  await withTempDir(async (root) => {
    for (const file of ['a.snap', 'sub/b.snap', 'sub/c.ts']) await put(root, file)
    assert.deepEqual(await walkFiles(root, { keep: (file) => file.endsWith('.snap') }), [
      'a.snap',
      'sub/b.snap',
    ])
  })
})

test('a symbolic link is neither followed nor listed', async () => {
  await withTempDir(async (root) => {
    await put(root, 'real/a.ts')
    await symlink(path.join(root, 'real'), path.join(root, 'link'))
    await symlink(path.join(root, 'real/a.ts'), path.join(root, 'real/b.ts'))
    assert.deepEqual(await walkFiles(root), ['real/a.ts'])
  })
})

test('a root that does not exist rejects with a not-found error', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(walkFiles(path.join(root, 'missing')), isNotFound)
  })
})
