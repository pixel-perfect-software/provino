// T9.16: `jestChangedFiles` against the real jest-changed-files 30.5.1 in-process (D27), over git
// repositories made in $TMPDIR. Git is hermetic here (no user or system config, no signing, fixed
// dates, a ceiling above each repository), and both sides run under the same environment.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ChangedFilesOptions } from '@provino/types'
import { jestChangedFiles } from './index.ts'

interface RealChangedFiles {
  getChangedFilesForRoots(
    roots: string[],
    options: { changedSince?: string; lastCommit?: boolean; withAncestor?: boolean },
  ): Promise<{ changedFiles: Set<string>; repos: Record<'git' | 'hg' | 'sl', Set<string>> }>
}

const core = createRequire(fileURLToPath(import.meta.resolve('jest-cli'))).resolve('@jest/core')
const real = createRequire(core)('jest-changed-files') as RealChangedFiles

const HERMETIC = [
  ['user.name', 'provino'],
  ['user.email', 'provino@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
  ['core.excludesFile', '/dev/null'],
  ['core.hooksPath', '/dev/null'],
] as const

let base = ''
const saved = { ...process.env }

before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'provino-git-')))
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CEILING_DIRECTORIES: base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(HERMETIC.length),
    ...Object.fromEntries(
      HERMETIC.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  })
})

after(async () => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
  Object.assign(process.env, saved)
  await rm(base, { recursive: true, force: true })
})

let count = 0
async function repo(files: Readonly<Record<string, string>>, init = true): Promise<string> {
  const dir = join(base, `r${count++}`)
  await write(dir, files)
  if (init) {
    git(dir, 'init', '-q', '--template=')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--no-verify', '-m', 'base')
  }
  return dir
}

async function write(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

/** Both providers over the same roots and options: the same files (as a set) and the same repositories. */
async function same(roots: string[], options: Omit<ChangedFilesOptions, 'roots'> = {}) {
  const expected = await real.getChangedFilesForRoots(roots, { ...options })
  const got = await jestChangedFiles({ roots, ...options })
  assert.deepEqual([...got.changedFiles].sort(), [...expected.changedFiles].sort())
  for (const kind of ['git', 'hg', 'sl'] as const) {
    assert.deepEqual([...got.repos[kind]].sort(), [...expected.repos[kind]].sort(), kind)
  }
  return got
}

const TREE = { 'a.ts': 'a\n', 'src/b.ts': 'b\n', 'lib/c.ts': 'c\n' }

test('a clean repository has no changed files', async () => {
  const dir = await repo(TREE)
  const got = await same([dir])
  assert.deepEqual(got.changedFiles, [])
  assert.deepEqual(got.repos.git, [dir])
})

test('modified, staged and untracked files are changed', async () => {
  const dir = await repo(TREE)
  await write(dir, { 'a.ts': 'a2\n', 'src/b.ts': 'b2\n', 'new.ts': 'n\n' })
  git(dir, 'add', 'src/b.ts')
  const got = await same([dir])
  assert.equal(got.changedFiles.length, 3)
})

test('a deleted file is reported as changed', async () => {
  const dir = await repo(TREE)
  await rm(join(dir, 'a.ts'))
  const got = await same([dir])
  assert.deepEqual(got.changedFiles, [join(dir, 'a.ts')])
})

test('roots are the include paths, relative to the repository', async () => {
  const dir = await repo(TREE)
  await write(dir, { 'src/b.ts': 'b2\n', 'lib/c.ts': 'c2\n' })
  const got = await same([join(dir, 'src')])
  assert.deepEqual(got.changedFiles, [join(dir, 'src/b.ts')])
  await same([join(dir, 'src'), join(dir, 'lib')])
})

test('--lastCommit is the files of HEAD', async () => {
  const dir = await repo(TREE)
  await write(dir, { 'a.ts': 'a2\n' })
  git(dir, 'commit', '-q', '-am', 'change a')
  await write(dir, { 'src/b.ts': 'b2\n' })
  const got = await same([dir], { lastCommit: true })
  assert.deepEqual(got.changedFiles, [join(dir, 'a.ts')])
})

test('--changedSince is the commits since the merge base, plus staged and unstaged', async () => {
  const dir = await repo(TREE)
  git(dir, 'checkout', '-q', '-b', 'feature')
  await write(dir, { 'a.ts': 'a2\n' })
  git(dir, 'commit', '-q', '-am', 'change a')
  git(dir, 'checkout', '-q', 'main')
  await write(dir, { 'lib/c.ts': 'c2\n' })
  git(dir, 'commit', '-q', '-am', 'change c on main')
  git(dir, 'checkout', '-q', 'feature')
  await write(dir, { 'src/b.ts': 'b2\n' })
  const got = await same([dir], { changedSince: 'main' })
  assert.deepEqual([...got.changedFiles].sort(), [join(dir, 'a.ts'), join(dir, 'src/b.ts')])
})

test('--changedFilesWithAncestor is since HEAD^', async () => {
  const dir = await repo(TREE)
  await write(dir, { 'a.ts': 'a2\n' })
  git(dir, 'commit', '-q', '-am', 'change a')
  await write(dir, { 'src/b.ts': 'b2\n' })
  await same([dir], { withAncestor: true })
  await same([dir], { withAncestor: true, changedSince: 'main' })
})

test('a directory in no repository has none', async () => {
  const dir = await repo(TREE, false)
  const got = await same([dir])
  assert.deepEqual(got, { changedFiles: [], repos: { git: [], hg: [], sl: [] } })
})

test('a bad ref rejects with the message execa gives', async () => {
  const dir = await repo(TREE)
  const expected = await real.getChangedFilesForRoots([dir], { changedSince: 'nope' }).then(
    () => assert.fail('jest-changed-files resolved'),
    (error: Error) => error.message,
  )
  const got = await jestChangedFiles({ roots: [dir], changedSince: 'nope' }).then(
    () => assert.fail('jestChangedFiles resolved'),
    (error: Error) => error.message,
  )
  assert.equal(got, expected)
  assert.match(got, /^Command failed with exit code 128: git diff --name-only nope\.\.\.HEAD -- \./)
})

test('two repositories as roots fail as in Jest: each gets the other as a path outside it', async () => {
  const one = await repo(TREE)
  const two = await repo(TREE)
  const messageOf = (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => assert.fail('resolved'),
      (error: Error) => error.message.split('\n')[0] ?? '',
    )
  // Two of git's commands fail at once, so which one rejects first is a race on both sides.
  const shape = /^Command failed with exit code 12[89]: git (diff --cached|ls-files) /
  assert.match(await messageOf(real.getChangedFilesForRoots([one, two], {})), shape)
  assert.match(await messageOf(jestChangedFiles({ roots: [one, two] })), shape)
})
