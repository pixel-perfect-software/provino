// Where the repo and its tools are, for the CLI and the tests.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The repo root.
 * @public
 */
export const ROOT: string = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * The package manifest.
 * @public
 */
export const MANIFEST_PATH: string = join(ROOT, 'tooling/boundaries/packages.json')

/**
 * dependency-cruiser's and Biome's JS entries. Run them with `process.execPath`, which also works
 * where `node_modules/.bin` holds `.cmd` shims (Windows).
 * @public
 */
export const DEPCRUISE_BIN: string = join(
  ROOT,
  'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs',
)
/** @public */
export const BIOME_BIN: string = join(ROOT, 'node_modules/@biomejs/biome/bin/biome')

/**
 * Directories the boundary checks never walk or cruise: dependencies, build output, and generated
 * or scratch output (bench suites, records and the instruction legs' inputs, recorder work dirs;
 * all git-ignored). The workspace
 * walk and dependency-cruiser's exclude both come from this one list.
 * @public
 */
export const SKIPPED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  '.tsc',
  '.turbo',
  '.suites',
  '.results',
  '.record',
  '.instructions',
]
