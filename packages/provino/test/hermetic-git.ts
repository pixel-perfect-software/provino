// The harness's hermetic git (`packages/harness/src/internal/scm.ts`), for the changed-file tests:
// no user or system config, nothing signed, fixed dates and author, no hooks, and a ceiling above
// the work directory, as `-c` pairs for our own git and as `GIT_CONFIG_*` for a runner's.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'provino'],
  ['user.email', 'provino@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
  ['core.excludesFile', '/dev/null'],
  ['core.hooksPath', '/dev/null'],
]

/** The variables a runner gets so its own git commands read nothing from this machine. */
export function gitEnv(ceiling: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
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

/** `git <args>` in `root`, hermetic, with no inherited `GIT_*` variable. */
export function git(root: string, args: readonly string[]): void {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  execFileSync(
    'git',
    [...GIT_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...args],
    { cwd: root, env: { ...env, ...gitEnv(dirname(root)) }, stdio: 'ignore' },
  )
}

/** `git init` with the recorder's exclude file: its outputs, the caches and `node_modules`. */
export async function initRepo(root: string): Promise<void> {
  git(root, ['init', '-q', '--template='])
  await mkdir(join(root, '.git', 'info'), { recursive: true })
  await writeFile(
    join(root, '.git', 'info', 'exclude'),
    '.harness-out/\n.jest-cache/\n.vite/\nnode_modules/\n',
  )
}

/** Every file staged and committed (the harness's `commit` step). */
export function commitAll(root: string, message: string): void {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', message])
}
