// Runs one Jest `mod-*` fixture end to end through `provino/node`'s `run()` (T4.8 through the
// worker, B13c; DECISIONS S4: a dev package runs Provino only through `provino/node` or the bin).
// The fixture is copied to a temp directory with its `packages` installed, beside the recorder's
// own trace and observe setups, and run with the Jest dialect from a generated config, one forked
// worker and the results cache off. What comes back is the normalized run and the trace, which the
// caller compares with the golden as the in-process check does.
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { NormalizedRun } from '@provino/types'
import { run } from 'provino/node'
import type { Fixture } from '../fixture.ts'
import { OBSERVE_SETUP_PATH, TRACE_ENV, traceSetupSource } from '../internal/runner-config.ts'
import { readTrace } from '../internal/trace.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import { copyFixture, installPackages } from '../record.ts'

/** What an end-to-end run reports, plus the work directory its messages name (gone by then). */
export interface ModEndToEnd {
  readonly exitCode: number
  readonly normalized: NormalizedRun
  readonly trace: readonly string[]
  readonly root: string
  /** What the run wrote to stderr: Provino's own errors, for a failing assertion's message. */
  readonly stderr: string
}

/** A sink that keeps what it is given. */
function collector(): { readonly stream: Writable; text(): string } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(chunk: unknown, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    }),
    text: () => chunks.join(''),
  }
}

/**
 * Runs `testFile` (relative to the fixture) through `run()` with the Jest dialect: one forked
 * worker, the normalized-json reporter, no results cache, and the recorder's `trace-setup.ts` and
 * `observe-setup.ts` as the config's `setupFiles`. `signal` stops the run (its worker is killed)
 * before the caller's own deadline, so a run that hangs never outlives its test.
 */
export async function runModEndToEnd(
  fixture: Fixture,
  testFile: string,
  signal: AbortSignal,
): Promise<ModEndToEnd> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'provino-mod-e2e-')))
  // A forked worker inherits the environment it is spawned with: the trace setup reads its file
  // from here, as the recorder sets it for the real runners. Put back with the work directory.
  const previous = process.env[TRACE_ENV]
  try {
    await copyFixture(fixture, root)
    await installPackages(fixture, root)
    await writeFile(path.join(root, 'trace-setup.ts'), traceSetupSource())
    await copyFile(OBSERVE_SETUP_PATH, path.join(root, 'observe-setup.ts'))
    const config = path.join(root, 'provino.config.mjs')
    await writeFile(
      config,
      `export default ${JSON.stringify(
        {
          dialect: 'jest',
          include: [testFile],
          setupFiles: ['./trace-setup.ts', './observe-setup.ts'],
        },
        null,
        2,
      )}\n`,
    )
    const traceFile = path.join(root, 'trace.txt')
    const outputFile = path.join(root, 'normalized.json')
    const stdout = collector()
    const stderr = collector()
    process.env[TRACE_ENV] = traceFile
    const { exitCode } = await run({
      config,
      cwd: root,
      pool: 'forks',
      maxWorkers: 1,
      cache: false,
      ci: true,
      reporters: [['normalized-json', { outputFile }]],
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal,
    })
    signal.throwIfAborted()
    const normalized = parseNormalizedRun(await readFile(outputFile, 'utf8'), outputFile)
    return { exitCode, normalized, trace: await readTrace(traceFile), root, stderr: stderr.text() }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, TRACE_ENV)
    else process.env[TRACE_ENV] = previous
    await rm(root, { recursive: true, force: true })
  }
}
