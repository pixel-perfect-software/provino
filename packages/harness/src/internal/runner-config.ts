// The config the recorder writes for each runner. Fixtures carry none, so this is the one place
// that decides how Jest and Vitest are run for a golden.
import path from 'node:path'
import { GOLDENS_DIR } from '../fixture.ts'

const LOCALE = 'C.UTF-8'
const INHERITED_NOISE: ReadonlySet<string> = new Set([
  'NODE_TEST_CONTEXT',
  'FORCE_COLOR',
  'NODE_ENV',
  'JEST_WORKER_ID',
  'VITEST',
])

/** Anything a runner config can hold; JSON-safe by construction. */
export interface JestConfigFile {
  readonly rootDir: string
  readonly transform: Readonly<Record<string, string>>
  readonly testMatch: readonly string[]
  readonly testPathIgnorePatterns: readonly string[]
  readonly testLocationInResults: true
  readonly cacheDirectory: string
  readonly watchman: false
}

/**
 * Jest runs `*.test.ts` except `*.vitest.test.ts`. Types are stripped by the harness transformer,
 * which hands the result to `babel-jest`.
 */
export function jestConfig(workDir: string, transformerPath: string): JestConfigFile {
  return {
    rootDir: workDir,
    transform: { '\\.[cm]?ts$': transformerPath },
    testMatch: ['<rootDir>/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', `/${GOLDENS_DIR}/`, '\\.vitest\\.test\\.ts$'],
    testLocationInResults: true,
    cacheDirectory: path.join(workDir, '.jest-cache'),
    watchman: false,
  }
}

/**
 * The source of the Vitest config file: a plain object, so it needs no import. Vitest runs
 * `*.test.ts` except `*.jest.test.ts`, with globals on and task locations in the report.
 */
export function vitestConfigSource(workDir: string): string {
  const config = {
    root: workDir,
    cacheDir: path.join(workDir, '.vite'),
    test: {
      globals: true,
      includeTaskLocation: true,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**', `**/${GOLDENS_DIR}/**`, '**/*.jest.test.ts'],
    },
  }
  return `export default ${JSON.stringify(config, null, 2)}\n`
}

/**
 * The runner's environment: quiet, UTC, CI-style and in one locale, so output doesn't depend on
 * the caller. `LANG` and `LC_ALL` are `C.UTF-8`, and `LANGUAGE` and every other `LC_*` variable
 * are dropped, because a locale changes number, date and sort output. `extra` (a fixture's `env`)
 * is applied last.
 */
export function runnerEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    // Inherited from `node --test`, a parent runner or a shell, any of these changes the output.
    if (name.startsWith('LC_') || name === 'LANGUAGE' || INHERITED_NOISE.has(name)) continue
    env[name] = value
  }
  return { ...env, CI: '1', NO_COLOR: '1', TZ: 'UTC', LANG: LOCALE, LC_ALL: LOCALE, ...extra }
}
