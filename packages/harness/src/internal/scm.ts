// Git for fixtures (B23c): a repository in the work directory, built by a fixture's `scm` steps,
// under an environment that reads nothing from the machine it runs on. No user config, no signing
// (so no 1Password prompt), fixed dates and authors, no hooks, no ignore file but the repository's
// own. The runner gets the same environment, so Jest's own git commands see what ours made.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import type { ScmStep } from '../fixture.ts'
import { runProcess } from '../run-process.ts'

/** The date every commit gets (author and committer). */
export const SCM_DATE = '2026-01-01T00:00:00Z'

/** Git's config for a recording, as `-c` pairs and again as `GIT_CONFIG_*` for the runner. */
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'provino'],
  ['user.email', 'provino@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
  // The user's global ignore file and hooks would change what `add -A` and `commit` do.
  ['core.excludesFile', '/dev/null'],
  ['core.hooksPath', '/dev/null'],
]

/** `-c key=value` for each hermetic setting. */
export const HERMETIC_GIT_ARGS: readonly string[] = GIT_CONFIG.flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`,
])

/** `env` without any `GIT_*` variable: `GIT_DIR`, `GIT_INDEX_FILE` and the rest come from a parent git. */
export function withoutGitVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')))
}

/**
 * The git variables of a recording: no global or system config, the fixed dates, the settings of
 * `GIT_CONFIG` through `GIT_CONFIG_COUNT`, and a ceiling at `ceiling` (the work directory's parent)
 * so a work directory without a repository doesn't find the checkout's own.
 */
export function hermeticGitEnv(ceiling: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: SCM_DATE,
    GIT_COMMITTER_DATE: SCM_DATE,
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
    ...Object.fromEntries(
      GIT_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

/** What a step runner needs: where, and the environment to run git in. */
export interface ScmRepo {
  /** The work directory. */
  readonly dir: string
  /** The parent of the work directory's real path, for `GIT_CEILING_DIRECTORIES`. */
  readonly ceiling: string
  /** The environment git starts from (default `process.env`), after its `GIT_*` variables are dropped. */
  readonly base?: NodeJS.ProcessEnv
}

const GIT_TIMEOUT_MS = 30_000

/** Runs `git <args>` in the repository under the hermetic environment; a failure is `HARNESS_SCM_FAILED`. */
export async function git(repo: ScmRepo, args: readonly string[]): Promise<string> {
  const result = await runProcess('git', [...HERMETIC_GIT_ARGS, ...args], {
    cwd: repo.dir,
    env: { ...withoutGitVariables(repo.base ?? process.env), ...hermeticGitEnv(repo.ceiling) },
    timeoutMs: GIT_TIMEOUT_MS,
    keepStreams: true,
  })
  if (result.exitCode !== 0 || result.timedOut) {
    throw new HarnessError(
      'HARNESS_SCM_FAILED',
      `git ${args.join(' ')} failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${result.output}`,
      { path: repo.dir },
    )
  }
  return result.streams?.stdout ?? ''
}

/**
 * `git init` in the work directory, with the recorder's own outputs kept out of every status:
 * `.harness-out/` (the config, the JSON, the trace), Jest's cache and `node_modules/`.
 */
export async function initRepo(repo: ScmRepo): Promise<void> {
  // An empty template: no sample hooks (which a sandbox may refuse to copy) and nothing from the system.
  await git(repo, ['init', '-q', '--template='])
  await mkdir(path.join(repo.dir, '.git', 'info'), { recursive: true })
  await writeFile(
    path.join(repo.dir, '.git', 'info', 'exclude'),
    '.harness-out/\n.jest-cache/\n.vite/\nnode_modules/\n',
  )
}

/** Runs one step in the repository. `write` and `remove` need no git. */
export async function runScmStep(repo: ScmRepo, step: ScmStep): Promise<void> {
  if ('git' in step) {
    await git(repo, step.git)
  } else if ('commit' in step) {
    await git(repo, ['add', '-A'])
    await git(repo, [
      'commit',
      '-q',
      '--allow-empty',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      step.commit,
    ])
  } else if ('branch' in step) {
    await git(repo, ['checkout', '-q', '-b', step.branch])
  } else if ('checkout' in step) {
    await git(repo, ['checkout', '-q', step.checkout])
  } else if ('write' in step) {
    for (const [file, text] of Object.entries(step.write)) {
      const target = path.join(repo.dir, file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, text)
    }
  } else {
    for (const file of step.remove) {
      await rm(path.join(repo.dir, file), { recursive: true, force: true })
    }
  }
}

/** Runs the steps in order. A fixture's `scm.steps` and, later, a watch run's `scm` steps. */
export async function runScmSteps(repo: ScmRepo, steps: readonly ScmStep[]): Promise<void> {
  for (const step of steps) await runScmStep(repo, step)
}
