// Where a suite hook's fixture error points (B25e, T5.9): `cli/vitest-fixture-suite-hook-frames`
// keeps Vitest 5.0.5's text of each, its first line and its frame in the test file, which Vitest's
// JSON (and so the runtime corpus) drops. The same file runs through core under the Vitest
// dialect's policy, and each suite error must give the same two lines.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { corePolicyFor } from './profiles.ts'
import { runUnderCore } from './run-core.ts'

const FIXTURE = fileURLToPath(
  new URL('../../fixtures/cli/vitest-fixture-suite-hook-frames/', import.meta.url),
)

/** The first line of an error as a reporter prints it, then its first frame in the test file. */
function printedLines(error: {
  readonly name: string
  readonly message: string
  readonly stack?: string
}): string[] {
  // The corpus imports the file with a query (\`?core-run=n\`); the position follows it.
  const found = /hooks\.test\.ts(?:\?[^:]*)?:(\d+:\d+)/.exec(error.stack ?? '')
  const frame = found === null ? undefined : `hooks.test.ts:${found[1]}`
  return [
    `${error.name}: ${error.message.split('\n')[0]}`,
    `❯ ${frame ?? '(no frame in the test file)'}`,
  ]
}

test("each suite hook's fixture error names Vitest's class and text and points at the hook", async () => {
  const golden = JSON.parse(readFileSync(`${FIXTURE}__goldens__/vitest.json`, 'utf8')) as {
    readonly observed: { readonly stderr: string }
  }
  const run = await runUnderCore(`${FIXTURE}hooks.test.ts`, FIXTURE, corePolicyFor.vitest)
  assert.deepEqual(
    run.suiteErrors.flatMap(printedLines),
    golden.observed.stderr.split('\n').map((line) => line.trim()),
  )
  // How each stack was rewritten (no reporter line shows it): Vitest 5.0.5's `validateSuiteHook`
  // and `getUsedProps` put the message in the site's header (`fixture.ts` L629, L704), while the
  // test-scoped check puts it first (L406).
  assert.deepEqual(
    run.suiteErrors.map((error) =>
      error.stack?.startsWith(`Error: ${error.message}`)
        ? 'header'
        : error.stack?.startsWith(error.message)
          ? 'message-first'
          : 'other',
    ),
    ['header', 'header', 'message-first'],
  )
})
