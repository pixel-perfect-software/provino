// Where the corpus lives on disk. `.refs/corpus/` is gitignored (DECISIONS S3): the tarballs, the
// installed trees and every run stay out of the repository, because they are large and full of
// machine paths. Only the manifest, `exclusions.json` and `flaky.json` are committed.
import path from 'node:path'

/** The environment variable that moves the work directory (tests, a second disk). */
export const CORPUS_DIR_ENV = 'PROVINO_CORPUS_DIR'

/**
 * `packages/harness/`, found from this file (`src/corpus/`).
 * @internal
 */
export function harnessPackageDir(): string {
  return path.resolve(import.meta.dirname, '..', '..')
}

/**
 * The repository's root (`packages/harness/` is two levels below it).
 * @internal
 */
export function repoRoot(): string {
  return path.resolve(harnessPackageDir(), '..', '..')
}

/**
 * The corpus work directory: `$PROVINO_CORPUS_DIR`, else `.refs/corpus/` at the repository root.
 * @public
 */
export function corpusWorkRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CORPUS_DIR_ENV]
  if (override !== undefined && override !== '') return path.resolve(override)
  return path.join(repoRoot(), '.refs', 'corpus')
}

/**
 * Where one repository's files go under the work directory.
 * @public
 */
export interface RepoPaths {
  /** `<work>/<id>/`. */
  readonly dir: string
  /** The tarball as downloaded, named for the commit so a changed pin never reuses it. */
  readonly tarball: string
  /** The extracted tree, and what the package manager installs into. */
  readonly src: string
  /** The commit `src` was extracted from. */
  readonly srcMarker: string
  /** Every package manager cache, so nothing touches the user's global stores. */
  readonly cache: string
  /** What the install recorded (`InstallRecord`). */
  readonly installRecord: string
  /** `runs/<subject>/<n>/`. */
  readonly runs: string
}

/**
 * The paths for one repository.
 * @public
 */
export function repoPaths(
  workRoot: string,
  repo: { readonly id: string; readonly sha: string },
): RepoPaths {
  const dir = path.join(workRoot, repo.id)
  return {
    dir,
    tarball: path.join(dir, `${repo.sha}.tar.gz`),
    src: path.join(dir, 'src'),
    srcMarker: path.join(dir, 'src.sha'),
    cache: path.join(dir, 'cache'),
    installRecord: path.join(dir, 'install.json'),
    runs: path.join(dir, 'runs'),
  }
}

/**
 * One reference run's directory: `<work>/<repo>/runs/<subject>/<n>/`.
 * @public
 */
export function runDir(paths: RepoPaths, subjectId: string, n: number): string {
  return path.join(paths.runs, subjectId, String(n))
}
