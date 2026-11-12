import { runCommand } from './exec.ts'

function git(root: string, args: readonly string[]): string | undefined {
  const result = runCommand('git', args, { cwd: root })
  return result.status === 0 ? result.output : undefined
}

/**
 * The commit `ref` names, or an error that says what to pass. A missing base fails the check:
 * a hygiene run that can't tell what changed must not pass for lack of an answer.
 * @internal
 */
export function resolveBase(root: string, ref: string): string {
  const sha = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim()
  if (sha === undefined || sha === '') {
    throw new Error(
      `cannot resolve the base "${ref}": fetch it, or pass --base <ref> (the branch this one will merge into)`,
    )
  }
  return sha
}

/**
 * `path` as it was at `ref`, or `undefined` when the file didn't exist there.
 * @internal
 */
export function fileAt(root: string, ref: string, path: string): string | undefined {
  const result = runCommand('git', ['show', `${ref}:${path}`], { cwd: root })
  return result.status === 0 ? result.output : undefined
}

/**
 * The files under `dir` that are new since `ref`: added in a commit, staged, or not yet tracked.
 * Paths are relative to the repository root.
 * @internal
 */
export function newFilesSince(root: string, ref: string, dir: string): readonly string[] {
  const added = git(root, ['diff', '--name-only', '--diff-filter=A', ref, '--', dir]) ?? ''
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--', dir]) ?? ''
  return [...new Set(`${added}\n${untracked}`.split('\n').filter((line) => line !== ''))].sort()
}
