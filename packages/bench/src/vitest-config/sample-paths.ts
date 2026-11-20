// Where B25c's Vitest config sample lives: the committed manifest, and the gitignored working
// directory under `.refs/` (tarballs, the shared node_modules, the GitHub answer cache, results).
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Tarballs, the shared node_modules, the API cache and results (gitignored `.refs/`), or the
 * directory `PROVINO_VITEST_CONFIG_SAMPLE_DIR` names (a checkout whose `.refs` can't be written
 * keeps a copy elsewhere; the directory ends in a slash).
 */
export const SAMPLE_DIR: string =
  process.env.PROVINO_VITEST_CONFIG_SAMPLE_DIR ??
  fileURLToPath(new URL('../../../../.refs/vitest-config-sample/', import.meta.url))

/** The committed manifest: repository, commit and path only. */
export const MANIFEST_PATH: string = fileURLToPath(
  new URL('../../../dialect-vitest/oracle/sample-manifest.json', import.meta.url),
)

/** Where a repository's tree goes. */
export function repoDir(repo: string): string {
  return join(SAMPLE_DIR, 'repos', repo.replace('/', '__'))
}
