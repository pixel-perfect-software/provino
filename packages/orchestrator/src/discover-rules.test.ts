// Discovery by a dialect reader's rules, over real directories under $TMPDIR. Real Jest's answers
// for the same kinds of tree are `packages/harness/fixtures/discovery/*`, which
// `packages/provino/test/list-tests.test.ts` runs the whole command against; this file covers what
// a recorded tree can't hold (symlinks) and the neutral form of the glob key.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { NeutralDiscovery } from '@provino/types'
import { discoverByRules, testFilePredicate } from './discover-rules.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-rules-')))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

function rules(rootDir: string, overrides: Partial<NeutralDiscovery> = {}): NeutralDiscovery {
  return {
    roots: [rootDir],
    extensions: ['js', 'ts'],
    includePatterns: { kind: 'glob', patterns: ['**/*.test.*'] },
    excludePatterns: ['/node_modules/'],
    crawlIgnorePatterns: [],
    ...overrides,
  }
}

const names = async (
  rootDir: string,
  discovery: NeutralDiscovery,
  globMatchesOn: 'absolute-path' | 'root-relative-path' = 'absolute-path',
): Promise<string[]> =>
  (await discoverByRules({ rootDir, discovery, globMatchesOn })).map((file) => file.relativePath)

describe('discoverByRules', () => {
  it('finds files under the roots with a listed extension that the globs match', async () => {
    const rootDir = await tree({
      'src/a.test.ts': '1',
      'src/b.test.tsx': '2',
      'lib/c.test.js': '3',
      'src/readme.md': '4',
    })
    assert.deepEqual(await names(rootDir, rules(rootDir, { roots: [join(rootDir, 'src')] })), [
      'src/a.test.ts',
    ])
    assert.deepEqual(await names(rootDir, rules(rootDir)), ['lib/c.test.js', 'src/a.test.ts'])
  })

  it('reports each file once, with its size, when roots overlap', async () => {
    const rootDir = await tree({ 'src/a.test.ts': 'abcde' })
    const files = await discoverByRules({
      rootDir,
      discovery: rules(rootDir, { roots: [rootDir, join(rootDir, 'src')] }),
      globMatchesOn: 'absolute-path',
    })
    assert.deepEqual(
      files.map((file) => [file.relativePath, file.sizeBytes]),
      [['src/a.test.ts', 5]],
    )
  })

  it('does not follow symlinks, to files or to directories (Jest crawls with enableSymlinks off)', async () => {
    const rootDir = await tree({ 'real/a.test.ts': '1', 'other/b.test.ts': '2' })
    await symlink(join(rootDir, 'real'), join(rootDir, 'linked-dir'))
    await symlink(join(rootDir, 'other', 'b.test.ts'), join(rootDir, 'linked-file.test.ts'))
    assert.deepEqual(await names(rootDir, rules(rootDir)), ['other/b.test.ts', 'real/a.test.ts'])
  })

  it('never lists node_modules or VCS directories, whatever the patterns say', async () => {
    const rootDir = await tree({
      'a.test.ts': '1',
      'node_modules/pkg/b.test.ts': '2',
      '.git/hooks/c.test.ts': '3',
      '.hidden/d.test.ts': '4',
    })
    assert.deepEqual(await names(rootDir, rules(rootDir, { excludePatterns: [] })), [
      '.hidden/d.test.ts',
      'a.test.ts',
    ])
  })

  it('compares an extension without regard to case, as find -iname does', async () => {
    const rootDir = await tree({ 'A.TEST.TS': '1', 'b.test.Ts': '2' })
    assert.deepEqual(
      await names(
        rootDir,
        rules(rootDir, {
          includePatterns: { kind: 'glob', patterns: ['**/*.TEST.*', '**/*.test.*'] },
        }),
      ),
      ['A.TEST.TS', 'b.test.Ts'],
    )
  })

  it('leaves out files crawlIgnorePatterns match, and files testPathIgnorePatterns match', async () => {
    const rootDir = await tree({
      'a.test.ts': '1',
      'built/b.test.ts': '2',
      'skip/c.test.ts': '3',
    })
    const discovery = rules(rootDir, {
      crawlIgnorePatterns: [`${rootDir}/built/`],
      excludePatterns: ['/skip/'],
    })
    assert.deepEqual(await names(rootDir, discovery), ['a.test.ts'])
  })

  it('matches testRegex on the absolute path', async () => {
    const rootDir = await tree({ 'specs/a.ts': '1', 'src/b.ts': '2', 'src/c.check.js': '3' })
    const discovery = rules(rootDir, {
      includePatterns: { kind: 'regex', patterns: ['/specs/.*\\.ts$', '\\.check\\.js$'] },
    })
    assert.deepEqual(await names(rootDir, discovery), ['specs/a.ts', 'src/c.check.js'])
  })

  it('finds nothing in a root that does not exist, and rejects a pattern that is not a regular expression', async () => {
    const rootDir = await tree({ 'a.test.ts': '1' })
    assert.deepEqual(
      await names(rootDir, rules(rootDir, { roots: [join(rootDir, 'missing')] })),
      [],
    )
    await assert.rejects(names(rootDir, rules(rootDir, { excludePatterns: ['('] })), {
      code: 'ORCH_BAD_PATTERN',
    })
  })
})

describe('globMatchesOn', () => {
  it('is what a relative glob sees: the absolute path under Jest, the path from the root otherwise', async () => {
    const rootDir = await tree({ 'src/a.test.ts': '1', 'lib/b.test.ts': '2' })
    const relative = rules(rootDir, {
      includePatterns: { kind: 'glob', patterns: ['src/**/*.test.ts'] },
    })
    assert.deepEqual(await names(rootDir, relative, 'absolute-path'), [])
    assert.deepEqual(await names(rootDir, relative, 'root-relative-path'), ['src/a.test.ts'])
  })
})

describe('testFilePredicate', () => {
  const root = '/project'
  const predicate = (patterns: string[]) =>
    testFilePredicate({
      rootDir: root,
      discovery: rules(root, { includePatterns: { kind: 'glob', patterns } }),
      globMatchesOn: 'absolute-path',
    })

  it('is globsToMatcher: a later glob can undo an earlier one, in order', () => {
    const isTest = predicate([
      '/project/src/**/*.test.ts',
      '!**/*.slow.test.ts',
      '**/keep/*.slow.test.ts',
    ])
    assert.equal(isTest('/project/src/a.test.ts'), true)
    assert.equal(isTest('/project/src/b.slow.test.ts'), false)
    assert.equal(isTest('/project/src/keep/c.slow.test.ts'), true)
    assert.equal(isTest('/project/other/d.test.ts'), false)
  })

  it('keeps everything a list of only negated globs does not drop', () => {
    const isTest = predicate(['!**/skip/**'])
    assert.equal(isTest('/project/a.test.ts'), true)
    assert.equal(isTest('/project/skip/b.test.ts'), false)
  })

  it('matches dot files, and no glob means no file', () => {
    assert.equal(predicate(['**/*.test.ts'])('/project/.hidden/a.test.ts'), true)
    assert.equal(predicate([])('/project/a.test.ts'), false)
  })
})
