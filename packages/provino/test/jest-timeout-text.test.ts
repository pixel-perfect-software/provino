// A test or hook that times out prints Jest 30.5.2's own words under `provino jest`, not core's
// (`CoreError: Test timed out in 25000ms.`): `thrown: "Exceeded timeout of N ms for a test.` and
// its advice, with the code frame and the frame at the place the test or hook was registered. The
// words and the registration frames are the recorded goldens', read from them: `facade/*` run on
// the bin, whose goldens give each message and the user frame under it. (`done`'s two texts are
// held to `runtime/done-callback` and `runtime/done-hooks` by the policy's claim in the harness.)
import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

/** A recorded failure: its message and the user frame the harness kept. */
interface RecordedError {
  readonly message: string
  readonly userFrame?: string
}

/** What Jest printed for a failure: each line of the message indented four spaces. */
function printed(message: string): string {
  return message
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

describe('a timeout under provino jest reads as Jest 30.5.2 prints it', () => {
  for (const id of [
    'facade/test-timeout-hooks',
    'facade/jest-set-timeout',
    'facade/set-timeout-late',
  ]) {
    it(id, async () => {
      const fixture = await loadFixture(id)
      const timeouts = fixture.golden.files.flatMap((file) =>
        (file.tests ?? []).flatMap((test) =>
          // The golden's tests carry their errors; `recorded.ts` types only the id and status.
          ((test as { readonly errors?: readonly RecordedError[] }).errors ?? [])
            // Not a negative timeout (`jest.setTimeout(-1)`): the facade turns it into a 1 ms
            // deadline before core sees it, so the text says `1 ms` where Jest's says `-1 ms`.
            .filter(
              (error) =>
                error.message.includes('Exceeded timeout') && !error.message.includes('of -'),
            )
            .map((error) => ({
              file: file.file,
              // The golden's `Error: thrown: "…"`, then the cause the harness appends.
              text: error.message.slice('Error: '.length, error.message.indexOf('\n\n[cause]')),
              frame: error.userFrame?.replace('<root>/', ''),
            })),
        ),
      )
      assert.ok(timeouts.length > 0, 'the fixture recorded a timeout')
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          ['jest', '--no-cache', '--ci', '-w', '1', '-c', 'jest.config.json'],
          { cwd: project.root },
        )
        assert.equal(ended.code, 1, ended.stderr)
        assert.doesNotMatch(ended.stderr, /CoreError|timed out in/)
        for (const { text, frame } of timeouts) {
          assert.ok(ended.stderr.includes(printed(text)), `${text}\n\n${ended.stderr}`)
          assert.ok(
            frame !== undefined && ended.stderr.includes(frame),
            `${frame}\n${ended.stderr}`,
          )
        }
      } finally {
        await project.dispose()
      }
    })
  }
})
