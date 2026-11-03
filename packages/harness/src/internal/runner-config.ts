// The config the recorder writes for each runner. Fixtures carry none, so this is the one place
// that decides how Jest and Vitest are run for a golden.
import path from 'node:path'
import { type FixtureProfile, GOLDENS_DIR } from '../fixture.ts'

const LOCALE = 'C.UTF-8'
const INHERITED_NOISE: ReadonlySet<string> = new Set([
  'NODE_TEST_CONTEXT',
  'FORCE_COLOR',
  'NODE_ENV',
  'JEST_WORKER_ID',
  'VITEST',
])

/**
 * The environment variable that names the file `trace(step)` appends to. The recorder sets it, so
 * a fixture's own `env` cannot move the trace.
 */
export const TRACE_ENV = 'PROVINO_TRACE_FILE'

/**
 * The source of the setup file both runners load before each test file. It installs
 * `globalThis.trace(step)`, which appends the step and a newline to the file in `TRACE_ENV`.
 * The append is synchronous, so steps land in call order even for concurrent tests. It needs no
 * import (Jest runs it as CommonJS, Vitest as ESM) and its types are erasable.
 */
export function traceSetupSource(): string {
  return [
    "const fs = process.getBuiltinModule('node:fs')",
    `const file = process.env.${TRACE_ENV}`,
    `if (file === undefined) throw new Error('${TRACE_ENV} is not set')`,
    'const target = globalThis as { trace?: (step: string) => void }',
    "target.trace = (step: string) => fs.appendFileSync(file, String(step) + '\\n')",
    '',
  ].join('\n')
}

/** Anything a runner config can hold; JSON-safe by construction. */
export interface JestConfigFile {
  readonly rootDir: string
  readonly transform: Readonly<Record<string, string>>
  readonly setupFiles: readonly string[]
  readonly testMatch: readonly string[]
  readonly testPathIgnorePatterns: readonly string[]
  readonly testLocationInResults: true
  readonly cacheDirectory: string
  readonly watchman: false
}

/**
 * Jest runs `*.test.ts` except `*.vitest.test.ts`. Types are stripped by the harness transformer,
 * which hands the result to `babel-jest`. `setupFile` is the trace setup (`traceSetupSource`).
 */
export function jestConfig(
  workDir: string,
  transformerPath: string,
  setupFile: string,
): JestConfigFile {
  return {
    rootDir: workDir,
    transform: { '\\.[cm]?ts$': transformerPath },
    setupFiles: [setupFile],
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
 * `setupFile` is the trace setup (`traceSetupSource`). The `vitest-list` profile adds
 * `sequence.hooks: 'list'`; every other profile keeps Vitest's default (`stack`).
 */
export function vitestConfigSource(
  workDir: string,
  setupFile: string,
  profile: FixtureProfile = 'vitest',
): string {
  const config = {
    root: workDir,
    cacheDir: path.join(workDir, '.vite'),
    test: {
      globals: true,
      includeTaskLocation: true,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**', `**/${GOLDENS_DIR}/**`, '**/*.jest.test.ts'],
      setupFiles: [setupFile],
      ...(profile === 'vitest-list' ? { sequence: { hooks: 'list' } } : {}),
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
