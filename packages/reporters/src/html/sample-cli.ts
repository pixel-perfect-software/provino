// Writes the HTML report of each sample state (`src/html/sample.ts`) to <dir>/<state>/index.html,
// for a look in a browser: serve <dir> and open /<state>/.
//
//   node packages/reporters/src/html/sample-cli.ts <dir> [state…]
//   python3 -m http.server --directory <dir>
//
// States: empty, all-passed, failures, crashed, 2000-files (all of them without a state). The same
// run is written every time (a fixed clock, a seeded stream), so a page can be compared before and
// after a change to its styles or script.

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createReporterBus } from '../bus.ts'
import { htmlReporter } from './index.ts'
import { playSample, SAMPLE_STATES, type SampleState, sampleClock } from './sample.ts'

const [dir, ...asked] = process.argv.slice(2)
if (dir === undefined) {
  process.stderr.write(
    `usage: node packages/reporters/src/html/sample-cli.ts <dir> [${SAMPLE_STATES.join('|')}]…\n`,
  )
  process.exit(2)
}
const unknown = asked.filter((name) => !SAMPLE_STATES.some((state) => state === name))
if (unknown.length > 0) {
  process.stderr.write(`unknown state ${unknown.join(', ')} (use ${SAMPLE_STATES.join(', ')})\n`)
  process.exit(2)
}
const states: readonly SampleState[] =
  asked.length === 0 ? SAMPLE_STATES : SAMPLE_STATES.filter((state) => asked.includes(state))

for (const state of states) {
  const folder = resolve(dir, state)
  await mkdir(folder, { recursive: true })
  const outputFile = join(folder, 'index.html')
  const clock = sampleClock()
  const bus = createReporterBus([
    htmlReporter({
      outputFile,
      root: '/project',
      now: clock.now,
      wallClock: () => Date.UTC(2026, 10, 19, 12, 0, 0),
      seed: 1827364,
      sample: true,
    }),
  ])
  await playSample(bus, state, clock)
  const failures = bus.failures()
  if (failures.length > 0) {
    process.stderr.write(`${state}: ${failures.map((failure) => failure.message).join('; ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`${outputFile}\n`)
}
