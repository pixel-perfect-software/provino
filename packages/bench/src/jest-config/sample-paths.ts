// Where a config sample lives (T11.6 for Jest, B25c for Vitest): the committed manifest, and the
// gitignored working directory under `.refs/` (tarballs, the shared node_modules, the GitHub
// answer cache, the per-config results).
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The three paths of one sample. */
export interface SamplePaths {
  /** Tarballs, the shared node_modules, the API cache and results (gitignored `.refs/`). */
  readonly SAMPLE_DIR: string
  /** The committed manifest: repository, commit and path only. */
  readonly MANIFEST_PATH: string
  /** Where a repository's tree goes. */
  repoDir(repo: string): string
}

/**
 * The paths of the sample `name` (`jest` or `vitest`). `dir` replaces the working directory (a
 * checkout whose `.refs` can't be written keeps a copy elsewhere; it ends in a slash).
 */
export function samplePaths(name: 'jest' | 'vitest', dir?: string): SamplePaths {
  const sampleDir =
    dir ?? fileURLToPath(new URL(`../../../../.refs/${name}-config-sample/`, import.meta.url))
  return {
    SAMPLE_DIR: sampleDir,
    MANIFEST_PATH: fileURLToPath(
      new URL(`../../../dialect-${name}/oracle/sample-manifest.json`, import.meta.url),
    ),
    repoDir: (repo) => join(sampleDir, 'repos', repo.replace('/', '__')),
  }
}

const jest = samplePaths('jest')
export const SAMPLE_DIR: string = jest.SAMPLE_DIR
export const MANIFEST_PATH: string = jest.MANIFEST_PATH
export const repoDir: (repo: string) => string = jest.repoDir
