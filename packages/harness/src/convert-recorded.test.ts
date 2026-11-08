// T12.3: the converters on real recorded input. `sample/__recorded__` holds what Jest 30.5.2 and
// Vitest 5.0.5 wrote for the sample (their JSON and the sidecar's console, paths rewritten to
// `/__root__`, `/__repo__` and `/__home__`) and the NormalizedRun each converts to. `self-test`
// keeps them honest: it runs both runners and fails when a fresh run's golden differs from the
// committed one. This test never starts a runner.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { convertRunnerJson } from './internal/convert-runner.ts'
import { assertNoPathLeak } from './internal/recording.ts'
import { parseNormalizedRun } from './parse-normalized-run.ts'
import { parseSidecar } from './sidecar.ts'

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..')
const RECORDED = path.join(PACKAGE_DIR, 'sample', '__recorded__')

function read(name: string): string {
  return readFileSync(path.join(RECORDED, name), 'utf8')
}

for (const runner of ['jest', 'vitest'] as const) {
  test(`${runner}: the recorded JSON and sidecar convert to the committed normalized run`, () => {
    const committed = parseNormalizedRun(
      read(`${runner}.normalized.json`),
      `${runner}.normalized.json`,
    )
    // What a conversion takes besides the runner's output, read back from the file: the suite,
    // the version, the machine, and the snapshot files `self-test` hashed. The converter only
    // copies these; everything else is its output.
    const options = {
      rootDir: '/__root__',
      suite: committed.suite,
      runnerVersion: committed.runnerVersion,
      env: committed.env,
      snapshotFiles: committed.snapshots?.files ?? [],
      console: parseSidecar(read(`${runner}.console.jsonl`), `${runner}.console.jsonl`),
    }
    const raw = read(`${runner}.raw.json`)
    const converted = convertRunnerJson(runner, raw, `${runner}.raw.json`, options)
    assert.deepEqual(converted, committed)
  })

  test(`${runner}: the recording has console output, a crash and a snapshot file`, () => {
    const run = parseNormalizedRun(read(`${runner}.normalized.json`), `${runner}.normalized.json`)
    const consoleLines = run.files.flatMap((file) => [
      ...(file.console ?? []),
      ...file.tests.flatMap((t) => t.console ?? []),
    ])
    assert.ok(consoleLines.length > 0, 'console output came through the sidecar')
    assert.deepEqual(
      run.files.filter((file) => file.status === 'crashed').map((file) => file.file),
      ['crash.test.ts'],
    )
    assert.deepEqual(
      run.snapshots?.files.map((file) => file.file),
      ['__snapshots__/snapshots.test.ts.snap'],
    )
  })

  test(`${runner}: no recorded file names this machine`, () => {
    const forbidden = [PACKAGE_DIR, path.resolve(PACKAGE_DIR, '..', '..'), os.homedir()]
    for (const name of [
      `${runner}.raw.json`,
      `${runner}.console.jsonl`,
      `${runner}.normalized.json`,
    ]) {
      assertNoPathLeak(read(name), forbidden, name)
    }
  })
}
