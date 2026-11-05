// Discovery over real directories under $TMPDIR: include and exclude globs, dot files, sorted
// output, POSIX relative paths and sizes.
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { discoverFiles } from './discover.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A directory holding `files` (relative path → text). */
async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-discover-')))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

describe('discoverFiles', () => {
  it('finds what include matches and exclude does not, sorted by relative path', async () => {
    const rootDir = await tree({
      'b.test.ts': '1',
      'a.test.ts': '22',
      'src/deep/c.test.ts': '333',
      'src/util.ts': 'not a test',
      'node_modules/pkg/x.test.ts': 'excluded',
    })
    const files = await discoverFiles({
      rootDir,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**'],
    })
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['a.test.ts', 'b.test.ts', 'src/deep/c.test.ts'],
    )
  })

  it('gives each file its absolute path and size in bytes', async () => {
    const rootDir = await tree({ 'sub/a.test.ts': 'abcd' })
    const [file] = await discoverFiles({ rootDir, include: ['**/*.test.ts'], exclude: [] })
    assert.deepEqual(file, {
      path: join(rootDir, 'sub', 'a.test.ts'),
      relativePath: 'sub/a.test.ts',
      sizeBytes: 4,
    })
  })

  it('includes dot files and files in dot directories', async () => {
    const rootDir = await tree({ '.hidden.test.ts': '', '.config/a.test.ts': '', 'b.test.ts': '' })
    const files = await discoverFiles({ rootDir, include: ['**/*.test.ts'], exclude: [] })
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['.config/a.test.ts', '.hidden.test.ts', 'b.test.ts'],
    )
  })

  it('lets exclude leave dot directories out when a pattern says so', async () => {
    const rootDir = await tree({ '.cache/a.test.ts': '', 'b.test.ts': '' })
    const files = await discoverFiles({
      rootDir,
      include: ['**/*.test.ts'],
      exclude: ['**/.cache/**'],
    })
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['b.test.ts'],
    )
  })

  it('lists a file matched by two patterns once', async () => {
    const rootDir = await tree({ 'a.test.ts': '' })
    const files = await discoverFiles({
      rootDir,
      include: ['**/*.test.ts', 'a.*'],
      exclude: [],
    })
    assert.equal(files.length, 1)
  })

  it('finds nothing for an empty include, or a root with no matches', async () => {
    const rootDir = await tree({ 'a.ts': '' })
    assert.deepEqual(await discoverFiles({ rootDir, include: [], exclude: [] }), [])
    assert.deepEqual(await discoverFiles({ rootDir, include: ['**/*.test.ts'], exclude: [] }), [])
  })

  it('sorts by code point, not by locale', async () => {
    const rootDir = await tree({ 'B.test.ts': '', 'a.test.ts': '', '_x.test.ts': '' })
    const files = await discoverFiles({ rootDir, include: ['*.test.ts'], exclude: [] })
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['B.test.ts', '_x.test.ts', 'a.test.ts'],
    )
  })

  it('returns a file reached through a symlinked directory once, at the first path in sort order', async () => {
    const rootDir = await tree({ 'a/x.test.js': 'x', 'b.test.js': 'b' })
    await symlink(join(rootDir, 'a'), join(rootDir, 'alias'), 'dir')
    // A loop: `a/loop` leads back to the root, which holds everything again.
    await symlink(rootDir, join(rootDir, 'a', 'loop'), 'dir')
    const files = await discoverFiles({ rootDir, include: ['**/*.test.js'], exclude: [] })
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['a/x.test.js', 'b.test.js'],
    )
  })

  it('keeps hard links as the separate files they are: same inode, different real paths', async () => {
    const rootDir = await tree({ 'a.test.js': 'x' })
    await link(join(rootDir, 'a.test.js'), join(rootDir, 'b.test.js'))
    const files = await discoverFiles({ rootDir, include: ['**/*.test.js'], exclude: [] })
    assert.deepEqual(
      files.map((f) => f.relativePath),
      ['a.test.js', 'b.test.js'],
    )
  })
})
