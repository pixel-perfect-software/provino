// The config the recorder writes for each runner. Fixtures carry none, so this is the one place
// that decides how Jest and Vitest are run for a golden.
import path from 'node:path'

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
    testPathIgnorePatterns: ['/node_modules/', '/__goldens__/', '\\.vitest\\.test\\.ts$'],
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
      exclude: ['**/node_modules/**', '**/__goldens__/**', '**/*.jest.test.ts'],
    },
  }
  return `export default ${JSON.stringify(config, null, 2)}\n`
}
