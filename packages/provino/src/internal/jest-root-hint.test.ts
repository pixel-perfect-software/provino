// The pieces of the no-root-config line (`provino jest`, `jest-root-hint.ts`): which directories it
// names and how it is worded. The bin end to end is `test/jest-root-hint.test.ts`.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { noRootConfigHint, projectsBelow } from './jest-root-hint.ts'

const made: string[] = []
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A temp tree of `files` (path to text) and its real path. */
async function tree(files: readonly string[], texts: Readonly<Record<string, string>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-root-hint-unit-')))
  made.push(root)
  for (const path of files) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), texts[path] ?? '')
  }
  return root
}

describe('projectsBelow and noRootConfigHint', () => {
  it('names the nearest config above each file once, from the working directory, sorted', async () => {
    const root = await tree(
      [
        'package.json',
        'z/jest.config.ts',
        'z/deep/er/a.test.js',
        'z/deep/b.test.js',
        'm/package.json',
        'm/c.test.js',
        // A package.json with no jest key does not end the walk here: the config two levels up is the nearest.
        'a/jest.config.mjs',
        'a/b/package.json',
        'a/b/c/d.test.js',
        'none/e.test.js',
      ],
      {
        'package.json': '{}\n',
        'm/package.json': '{ "jest": { "testEnvironment": "node" } }\n',
        'a/b/package.json': '{}\n',
      },
    )
    const files = [
      'z/deep/er/a.test.js',
      'z/deep/b.test.js',
      'm/c.test.js',
      'a/b/c/d.test.js',
      'none/e.test.js',
      'root.test.js',
    ].map((file) => join(root, file))
    assert.deepEqual(projectsBelow(root, files), ['a', 'm', 'z'])
    // The root's own config is not below it, and paths are from the working directory.
    assert.deepEqual(projectsBelow(join(root, 'a'), [join(root, 'a/b/c/d.test.js')], root), [])
    assert.deepEqual(projectsBelow(root, files.slice(2, 3), join(root, 'z')), ['../m'])
    assert.deepEqual(projectsBelow(root, []), [])
  })

  it('reads a directory that is gone as one with no config', () => {
    assert.deepEqual(projectsBelow('/nowhere/root', ['/nowhere/root/gone/a.test.js']), [])
  })

  it('words the line for none, one and many, and cuts the list at five', () => {
    assert.equal(noRootConfigHint([]), undefined)
    assert.equal(
      noRootConfigHint(['a']),
      'provino: no Jest config here; 1 directory below has one (a). Run with --projects <dirs> to use them.',
    )
    assert.equal(
      noRootConfigHint(['a', 'b', 'c', 'd', 'e']),
      'provino: no Jest config here; 5 directories below have one (a, b, c, d, e). Run with --projects <dirs> to use them.',
    )
    assert.equal(
      noRootConfigHint(['a', 'b', 'c', 'd', 'e', 'f']),
      'provino: no Jest config here; 6 directories below have one (a, b, c, d, e, …). Run with --projects <dirs> to use them.',
    )
  })
})
