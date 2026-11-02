import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { findStaleGoldens } from './stale-goldens.ts'

async function withTempDir(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-stale-'))
  try {
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function put(root: string, file: string, text = '{}'): Promise<string> {
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
  return target
}

test('a golden this run did not produce is stale: a removed runner, a lost manifest, a stray file', async () => {
  await withTempDir(async (root) => {
    await put(root, 'area/kept/fixture.json')
    const kept = await put(root, 'area/kept/__goldens__/jest.json')
    await put(root, 'area/kept/__goldens__/vitest.json')
    await put(root, 'area/kept/__goldens__/notes.json')
    await put(root, 'area/orphan/__goldens__/jest.json')
    await put(root, 'area/orphan/a.test.ts')
    await put(root, 'node_modules/pkg/__goldens__/jest.json')
    await put(root, 'area/kept/__goldens__/readme.md')

    const stale = await findStaleGoldens([root], new Set([kept]))
    assert.deepEqual(
      stale.map((file) => path.relative(root, file)),
      [
        'area/kept/__goldens__/notes.json',
        'area/kept/__goldens__/vitest.json',
        'area/orphan/__goldens__/jest.json',
      ],
    )
  })
})

test('nothing is stale when every golden was produced, or when there are no goldens', async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await findStaleGoldens([root], new Set()), [])
    const jest = await put(root, 'a/b/__goldens__/jest.json')
    const vitest = await put(root, 'a/b/__goldens__/vitest.json')
    assert.deepEqual(await findStaleGoldens([root], new Set([jest, vitest])), [])
  })
})

test('only the given roots are scanned, and a root that does not exist is not an error', async () => {
  await withTempDir(async (root) => {
    await put(root, 'one/__goldens__/jest.json')
    const two = await put(root, 'two/__goldens__/jest.json')
    const stale = await findStaleGoldens(
      [path.join(root, 'two'), path.join(root, 'missing')],
      new Set(),
    )
    assert.deepEqual(stale, [two])
  })
})
