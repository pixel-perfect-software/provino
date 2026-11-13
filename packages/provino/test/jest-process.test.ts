// A test file's `process` under `provino jest`, held to what Jest 30.5.2 recorded on the same
// trees (`env/process-*`): every file gets its own copy (`orchestrator.processObject:
// 'per-file'`), so a listener or an `env` change one file makes never reaches the next file in the
// worker, an `exit` listener never runs, and a setup file that adds an `exit` listener per file
// never passes Node's limit of 10. Each recorded test's title holds what its file saw, so equal
// titles and statuses are equal observations.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { provinoRun, type Statuses, sorted } from './live-jest.ts'
import { loadFixture, materialize, type RecordedGolden } from './recorded.ts'

/** The golden's tests as `<file>::<title>` to Jest's status word, as `provinoRun` keys them. */
function recordedStatuses(golden: RecordedGolden): Map<string, string> {
  const word: Readonly<Record<string, string>> = { skipped: 'pending' }
  const statuses = new Map<string, string>()
  for (const file of golden.files) {
    for (const test of file.tests ?? []) {
      statuses.set(`${file.file}::${test.id.path.join(' ')}`, word[test.status] ?? test.status)
    }
  }
  return statuses
}

/** A captured file's text, or `null` when the run left none (the golden's `observed.files`). */
async function captured(root: string, path: string): Promise<string | null> {
  return readFile(join(root, path), 'utf8').catch(() => null)
}

/**
 * What Provino does not reproduce yet in `env/process-identity`, each the recorded title and the
 * one Provino gives (follow-ups, not built here): jest-runtime serves the file's `process` for
 * `require('process')`, where the loader serves the worker's; and jest-util's copy reads
 * `features.require_module` as `false`, where Provino's keeps the worker's value.
 */
const DECLARED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'env/process-identity': {
    "identity.test.ts::require('process') is process: true":
      "identity.test.ts::require('process') is process: false",
    "identity.test.ts::require('node:process') is process: true":
      "identity.test.ts::require('node:process') is process: false",
    'identity.test.ts::process.features.require_module: false': `identity.test.ts::process.features.require_module: ${String(
      (process.features as { require_module?: boolean }).require_module,
    )}`,
  },
}

/** The recorded statuses with each declared title replaced by Provino's. */
function expectedOf(id: string, recorded: ReadonlyMap<string, string>): Statuses {
  const declared = DECLARED[id] ?? {}
  const expected = new Map<string, string>()
  for (const [key, status] of recorded) expected.set(declared[key] ?? key, status)
  return expected
}

async function runRecorded(id: string): Promise<{
  readonly golden: RecordedGolden
  readonly root: string
  readonly code: number
  readonly statuses: Statuses
  readonly stderr: string
  dispose(): Promise<void>
}> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    const ended = await provinoRun(project.root)
    return { golden: fixture.golden, root: project.root, ...ended, dispose: project.dispose }
  } catch (error) {
    await project.dispose()
    throw error
  }
}

describe("a test file's process under provino jest, against Jest 30.5.2", () => {
  for (const [id, title] of [
    [
      'env/process-per-file-listeners',
      'a later file in the worker sees none of the listeners an earlier one added, and no exit listener runs',
    ],
    [
      'env/process-per-file-env',
      'an env change stays in its file, and a child process started without env does not see it',
    ],
    [
      'env/process-setup-listener-per-file',
      'a setup file’s exit listener, added for each of 12 files, is one per file and never runs',
    ],
    [
      'env/process-uncaught-listener',
      'a file’s uncaughtException listener is not called; the runner charges the test',
    ],
    ['env/process-identity', 'the global, getBuiltinModule and send are the file’s copy'],
  ] as const) {
    it(`${id}: ${title}`, async () => {
      const run = await runRecorded(id)
      try {
        const recorded = recordedStatuses(run.golden)
        assert.ok(recorded.size > 0)
        assert.deepEqual(sorted(run.statuses), sorted(expectedOf(id, recorded)), run.stderr)
        assert.equal(run.code, run.golden.observed?.exitCode, run.stderr)
        for (const [path, text] of Object.entries(run.golden.observed?.files ?? {})) {
          assert.equal(await captured(run.root, path), text, `${path} is as Jest left it`)
        }
        assert.doesNotMatch(run.stderr, /MaxListenersExceededWarning/)
      } finally {
        await run.dispose()
      }
    })
  }

  it('each declared difference still differs from the recording', () => {
    for (const declared of Object.values(DECLARED)) {
      for (const [recorded, provino] of Object.entries(declared)) {
        assert.notEqual(provino, recorded)
      }
    }
  })
})
