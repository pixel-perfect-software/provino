// Runs one Jest `config-*` mocking fixture end to end through a real forked worker, with the mock
// cleanup configured the way a Jest project configures it: `clearMocks`, `resetMocks` and
// `restoreMocks` in a `jest.config.json`, read by the Jest dialect's config reader (B14b), turned
// into a neutral project and resolved by `@provino/config`, then run by `runProject` (T4.10). That
// is the path `provino jest` takes once B14c builds it; `run()` has no way to name those keys yet.
// What comes back is the normalized run and the fixture's trace, which the caller compares with the
// golden as the in-process check does.
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveNeutralProject } from '@provino/config'
import { createJestConfigReader, jestNodeDialect } from '@provino/dialect-jest/node'
import { runProject } from '@provino/orchestrator'
import { createReporterBus, normalizedJsonReporter } from '@provino/reporters'
import type { NormalizedRun } from '@provino/types'
import type { Fixture } from '../fixture.ts'
import { OBSERVE_SETUP_PATH, TRACE_ENV, traceSetupSource } from '../internal/runner-config.ts'
import { readTrace } from '../internal/trace.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import { copyFixture } from '../record.ts'

/** What the run reports. */
export interface ConfigEndToEnd {
  readonly normalized: NormalizedRun
  readonly trace: readonly string[]
}

/** The Jest config keys a fixture's `mockCleanup` turns on. */
function jestCleanupKeys(fixture: Fixture): Record<string, boolean> {
  const cleanup = fixture.manifest.mockCleanup ?? {}
  return {
    ...(cleanup.clear === undefined ? {} : { clearMocks: cleanup.clear }),
    ...(cleanup.reset === undefined ? {} : { resetMocks: cleanup.reset }),
    ...(cleanup.restore === undefined ? {} : { restoreMocks: cleanup.restore }),
  }
}

/**
 * Runs `testFile` (relative to the fixture) under a Jest config carrying the fixture's cleanup
 * flags: one forked worker, no results cache, the recorder's `trace-setup.ts` and
 * `observe-setup.ts` as `setupFiles`. `signal` stops the run before the caller's own deadline.
 */
export async function runConfigEndToEnd(
  fixture: Fixture,
  testFile: string,
  signal: AbortSignal,
): Promise<ConfigEndToEnd> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'provino-config-e2e-')))
  const previous = process.env[TRACE_ENV]
  try {
    await copyFixture(fixture, root)
    await writeFile(path.join(root, 'trace-setup.ts'), traceSetupSource())
    await copyFile(OBSERVE_SETUP_PATH, path.join(root, 'observe-setup.ts'))
    await writeFile(
      path.join(root, 'jest.config.json'),
      `${JSON.stringify(
        {
          rootDir: root,
          testMatch: [`<rootDir>/${testFile}`],
          setupFiles: ['<rootDir>/trace-setup.ts', '<rootDir>/observe-setup.ts'],
          ...jestCleanupKeys(fixture),
        },
        null,
        2,
      )}\n`,
    )
    const reader = createJestConfigReader({ cwd: root, seed: 0 })
    const source = await reader.find(root)
    if (source === undefined) throw new Error(`no Jest config was found in ${root}`)
    const resolved = await reader.resolve(await reader.load(source), source)
    const [neutral] = reader.toNeutral(resolved.value).value
    if (neutral === undefined) throw new Error('the Jest config gave no project')
    const project = await resolveNeutralProject(neutral, {
      dialect: jestNodeDialect,
      environments: {
        node: { module: import.meta.resolve('@provino/env-node'), export: 'nodeEnvironment' },
      },
      ci: true,
    })
    const traceFile = path.join(root, 'trace.txt')
    const outputFile = path.join(root, 'normalized.json')
    process.env[TRACE_ENV] = traceFile
    const bus = createReporterBus([
      normalizedJsonReporter({
        outputFile,
        suite: fixture.id,
        runner: 'provino:jest',
        runnerVersion: '0.0.0',
        ci: true,
      }),
    ])
    await runProject(project, {
      bus,
      pool: { kind: 'forks', maxWorkers: 1 },
      cache: false,
      signal,
    })
    signal.throwIfAborted()
    const failures = bus.failures()
    if (failures.length > 0) throw new AggregateError(failures, 'a reporter failed')
    return {
      normalized: parseNormalizedRun(await readFile(outputFile, 'utf8'), outputFile),
      trace: await readTrace(traceFile),
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, TRACE_ENV)
    else process.env[TRACE_ENV] = previous
    await rm(root, { recursive: true, force: true })
  }
}
