// Where T11.6's sample lives: the committed manifest, and the gitignored working directory under
// `.refs/` (tarballs, the shared node_modules, the GitHub answer cache, the per-config results).
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Tarballs, the shared node_modules, the API cache and results (gitignored `.refs/`). */
export const SAMPLE_DIR: string = fileURLToPath(
  new URL('../../../../.refs/jest-config-sample/', import.meta.url),
)

/** The committed manifest: repository, commit and path only. */
export const MANIFEST_PATH: string = fileURLToPath(
  new URL('../../../dialect-jest/oracle/sample-manifest.json', import.meta.url),
)

/** Where a repository's tree goes. */
export function repoDir(repo: string): string {
  return join(SAMPLE_DIR, 'repos', repo.replace('/', '__'))
}
