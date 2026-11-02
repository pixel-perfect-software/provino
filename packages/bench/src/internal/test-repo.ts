import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function git(cwd: string, ...args: readonly string[]): void {
  // Identity and signing are set on the command line so a developer's global git config, or its
  // absence in CI, never changes what the fixture does.
  execFileSync(
    'git',
    [
      '-c',
      'user.name=bench-test',
      '-c',
      'user.email=bench@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  )
}

/**
 * Makes a git repository at `dir` with one empty commit, for tests of the commit and dirty flag.
 * With `dirty` it also leaves an untracked file, so `git status --porcelain` is not empty.
 * @internal
 */
export async function makeRepo(dir: string, options?: { readonly dirty?: boolean }): Promise<void> {
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'initial')
  if (options?.dirty === true) await writeFile(join(dir, 'untracked.txt'), 'not committed\n')
}
