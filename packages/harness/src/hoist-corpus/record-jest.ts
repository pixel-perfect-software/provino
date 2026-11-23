// Records real Babel's output for the Jest generated layouts (`jest-recording.ts`):
// `pnpm --filter @provino/harness record:hoist`. With `--check` it writes nothing and exits 1 when
// the committed recording's content differs from a fresh one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { lineDiff } from '../internal/text-diff.ts'
import { jestBabelFingerprint, realJestBabel } from './check.ts'
import { GENERATED, generateLayouts } from './generate.ts'
import { JEST_RECORDING_PATH, layoutsHash, packRecording, recordingText } from './jest-recording.ts'

/** How many lines of the difference a stale check prints, each cut to this many characters. */
const SHOWN_LINES = 8
const SHOWN_WIDTH = 160

const check = process.argv.slice(2).includes('--check')
const layouts = generateLayouts('jest', GENERATED.jest.count, GENERATED.jest.seed)
const recording = {
  fingerprint: jestBabelFingerprint(),
  layouts: layoutsHash(layouts),
  outputs: layouts.map(realJestBabel),
}
if (check) {
  const text = recordingText(recording)
  const committed = existsSync(JEST_RECORDING_PATH)
    ? gunzipSync(readFileSync(JEST_RECORDING_PATH)).toString('utf8')
    : undefined
  if (committed !== text) {
    if (committed !== undefined) {
      const shown = lineDiff(committed, text)
        .split('\n')
        .slice(0, SHOWN_LINES)
        .map((line) => (line.length > SHOWN_WIDTH ? `${line.slice(0, SHOWN_WIDTH)}...` : line))
      console.error(
        `the committed recording (-) and a fresh one (+), first lines:\n${shown.join('\n')}`,
      )
    }
    console.error(
      `${JEST_RECORDING_PATH} is stale: run \`pnpm --filter @provino/harness record:hoist\``,
    )
    process.exit(1)
  }
  console.log(`${layouts.length} layouts agree with the recording`)
} else {
  writeFileSync(JEST_RECORDING_PATH, packRecording(recording))
  console.log(`recorded ${layouts.length} layouts`)
}
