import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import type { ScmStep } from '../fixture.ts'
import {
  git,
  hermeticGitEnv,
  initRepo,
  runScmSteps,
  SCM_DATE,
  type ScmRepo,
  withoutGitVariables,
} from './scm.ts'

/** A directory under the system temp directory (outside the checkout), and a repository handle for it. */
async function withRepo(
  use: (repo: ScmRepo, root: string) => Promise<void>,
  base?: (root: string) => Promise<NodeJS.ProcessEnv>,
): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'provino-scm-')))
  try {
    const dir = path.join(root, 'work')
    await mkdir(dir)
    await use(
      { dir, ceiling: root, ...(base === undefined ? {} : { base: await base(root) }) },
      root,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const STEPS: readonly ScmStep[] = [
  { write: { 'a.txt': 'one\n', 'src/b.txt': 'two\n' } },
  { commit: 'base' },
  { branch: 'feature' },
  { write: { 'a.txt': 'changed\n' } },
  { commit: 'change a' },
  { remove: ['src/b.txt'] },
  { checkout: 'main' },
  { write: { 'untracked.txt': 'new\n' } },
]

/** What a user's machine could set that would change a repository's commits or its status. */
async function hostileEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = path.join(root, 'home')
  await mkdir(path.join(home, '.config', 'git'), { recursive: true })
  await writeFile(
    path.join(home, '.gitconfig'),
    [
      '[user]\n\tname = Somebody Else\n\temail = else@example.com\n',
      '[commit]\n\tgpgsign = true\n',
      '[gpg]\n\tprogram = /nonexistent/gpg\n\tformat = ssh\n',
      '[core]\n\thooksPath = /nonexistent/hooks\n',
      '[init]\n\tdefaultBranch = trunk\n',
    ].join(''),
  )
  await writeFile(path.join(home, '.config', 'git', 'ignore'), 'untracked.txt\n')
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_AUTHOR_NAME: 'Env Author',
    GIT_COMMITTER_EMAIL: 'env@example.com',
    GIT_AUTHOR_DATE: '2020-02-02T02:02:02Z',
    GIT_DIR: path.join(root, 'elsewhere'),
  }
}

test('the steps build a repository whose commits do not depend on the machine', async () => {
  // The same tree, author, date and message give the same commit whatever the user's own git
  // configuration, ignore file, hooks, signing setup and `GIT_*` variables say.
  const heads: string[] = []
  for (const hostile of [false, true]) {
    await withRepo(
      async (repo) => {
        await initRepo(repo)
        await runScmSteps(repo, STEPS)
        heads.push((await git(repo, ['rev-parse', 'HEAD'])).trim())
        assert.equal((await git(repo, ['branch', '--show-current'])).trim(), 'main')
        assert.equal(
          (await git(repo, ['log', '-1', '--format=%an <%ae> %cn <%ce> %aI %cI %G?'])).trim(),
          'provino <provino@example.invalid> provino <provino@example.invalid> 2026-01-01T00:00:00Z 2026-01-01T00:00:00Z N',
        )
        // `remove` left a tracked file deleted, and `untracked.txt` shows although the user's own
        // global ignore file names it.
        assert.equal(
          (await git(repo, ['status', '--porcelain'])).trim(),
          'D src/b.txt\n?? untracked.txt',
          'the tree is as the steps left it',
        )
      },
      hostile ? hostileEnvironment : undefined,
    )
  }
  assert.equal(heads[0], heads[1])
  assert.match(heads[0] ?? '', /^[0-9a-f]{40}$/)
})

test('two recordings of the same steps give the same commit hash', async () => {
  const heads: string[] = []
  for (let run = 0; run < 2; run++) {
    await withRepo(async (repo) => {
      await initRepo(repo)
      await runScmSteps(repo, STEPS)
      heads.push((await git(repo, ['rev-parse', 'HEAD', 'feature'])).trim())
    })
  }
  assert.equal(heads[0], heads[1])
})

test('initRepo keeps the recorder outputs out of the status and writes no sample hooks', async () => {
  await withRepo(async (repo) => {
    await initRepo(repo)
    await runScmSteps(repo, [
      { write: { 'a.txt': 'x\n', '.harness-out/jest.json': '[]', 'node_modules/p/i.js': '' } },
    ])
    assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '?? a.txt')
    const exclude = await readFile(path.join(repo.dir, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^\.harness-out\/$/m)
    await assert.rejects(readFile(path.join(repo.dir, '.git', 'hooks', 'pre-commit.sample')))
  })
})

test('a step that fails is HARNESS_SCM_FAILED and names the command', async () => {
  await withRepo(async (repo) => {
    await initRepo(repo)
    await assert.rejects(
      runScmSteps(repo, [{ checkout: 'no-such-ref' }]),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'HARNESS_SCM_FAILED' &&
        error.message.includes('checkout -q no-such-ref'),
    )
  })
})

test('the ceiling keeps a directory with no repository from finding the one above it', async () => {
  await withRepo(async (repo, root) => {
    // The repository is `root/outer`, the work directory is `root/outer/inner` without its own.
    const outer = path.join(root, 'outer')
    await mkdir(path.join(outer, 'inner'), { recursive: true })
    await initRepo({ dir: outer, ceiling: root })
    const inner = { dir: path.join(outer, 'inner'), ceiling: outer }
    await assert.rejects(git(inner, ['rev-parse', '--show-toplevel']), HarnessError)
    // Without the ceiling at its parent it finds `outer`, which is what the ceiling is for.
    assert.equal(
      (await git({ dir: inner.dir, ceiling: root }, ['rev-parse', '--show-toplevel'])).trim(),
      outer,
    )
    assert.equal(repo.dir, path.join(root, 'work'))
  })
})

test('withoutGitVariables drops every GIT_ variable and keeps the rest', () => {
  assert.deepEqual(
    withoutGitVariables({ PATH: '/bin', GIT_DIR: '/x', GIT_INDEX_FILE: 'y', HOME: '/h' }),
    {
      PATH: '/bin',
      HOME: '/h',
    },
  )
})

test('hermeticGitEnv fixes the dates, drops global and system config and sets the ceiling', () => {
  const env = hermeticGitEnv('/parent')
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_AUTHOR_DATE, SCM_DATE)
  assert.equal(env.GIT_COMMITTER_DATE, SCM_DATE)
  assert.equal(env.GIT_CEILING_DIRECTORIES, '/parent')
  const count = Number(env.GIT_CONFIG_COUNT)
  const settings = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]),
  )
  assert.equal(settings['commit.gpgsign'], 'false')
  assert.equal(settings['user.name'], 'provino')
  assert.equal(settings['user.email'], 'provino@example.invalid')
  assert.equal(settings['core.hooksPath'], '/dev/null')
  assert.equal(settings['init.defaultBranch'], 'main')
})
