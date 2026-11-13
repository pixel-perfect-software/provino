import { runCommand } from './exec.ts'

function git(root: string, args: readonly string[]): string | undefined {
  const result = runCommand('git', args, { cwd: root })
  // git that cannot run is not a ref that doesn't exist.
  if (result.error !== undefined)
    throw new Error(`git ${args[0]} failed\n${result.output}`, { cause: result.error })
  return result.status === 0 ? result.stdout : undefined
}

/**
 * Where this branch left `ref`: the merge base of `ref` and HEAD. Not `ref`'s tip: on a stacked
 * branch whose parent has moved on, the tip holds other PRs' API reports and changesets, and
 * measuring against it blames their changes on this branch (and lets a changeset a release has
 * since consumed count as this branch's). A missing ref, or one with no common history, fails the
 * check: a hygiene run that can't tell what changed must not pass for lack of an answer.
 * @internal
 */
export function resolveBase(root: string, ref: string): string {
  const tip = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim()
  if (tip === undefined || tip === '') {
    throw new Error(
      `cannot resolve the base "${ref}": fetch it, or pass --base <ref> (the branch this one will merge into)`,
    )
  }
  const base = git(root, ['merge-base', tip, 'HEAD'])?.trim()
  if (base === undefined || base === '') {
    throw new Error(
      `the base "${ref}" has no common history with HEAD: pass --base <ref> for the branch this one will merge into`,
    )
  }
  return base
}

/**
 * `path` as it was at `ref`, or `undefined` when the file didn't exist there.
 * @internal
 */
export function fileAt(root: string, ref: string, path: string): string | undefined {
  return git(root, ['show', `${ref}:${path}`])
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
