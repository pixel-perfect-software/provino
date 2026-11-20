// Where B25c's Vitest config sample lives: the committed manifest, and the working directory under
// `.refs/`, or the one `PROVINO_VITEST_CONFIG_SAMPLE_DIR` names.
import { samplePaths } from '../jest-config/sample-paths.ts'

const paths = samplePaths('vitest', process.env.PROVINO_VITEST_CONFIG_SAMPLE_DIR)
export const SAMPLE_DIR: string = paths.SAMPLE_DIR
export const MANIFEST_PATH: string = paths.MANIFEST_PATH
export const repoDir: (repo: string) => string = paths.repoDir
