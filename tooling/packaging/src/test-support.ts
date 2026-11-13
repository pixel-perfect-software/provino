// Helpers shared by the tests. Not a test file: `node --test` runs only `*.test.ts`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'

const scratch: string[] = []
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/**
 * Writes `files` (path → content) under `dir`, creating directories as needed.
 * @internal
 */
export function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

/**
 * A fresh directory under the OS temp dir holding `files`, removed after the test file finishes:
 * a packed tarball, a scratch project, a repository.
 * @internal
 */
export function scratchDir(prefix: string, files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `provino-${prefix}-`))
  scratch.push(dir)
  writeFiles(dir, files)
  return dir
}

/** A scratch git repository and the git command in it. */
export interface Repository {
  readonly dir: string
  /** Runs `git <args>` in the repository (unsigned, with a committer) and returns its stdout, trimmed. */
  readonly git: (...args: string[]) => string
}

/**
 * A scratch git repository on `main` with `files` written, not yet committed.
 * @internal
 */
export function repository(files: Readonly<Record<string, string>> = {}): Repository {
  const dir = scratchDir('repo', files)
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd: dir, encoding: 'utf8' },
    ).trim()
  git('init', '-q', '--initial-branch=main')
  return { dir, git }
}
