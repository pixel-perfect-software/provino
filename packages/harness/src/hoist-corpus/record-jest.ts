// Records real Babel's output for the Jest generated layouts (`jest-recording.ts`):
// `pnpm --filter @provino/harness record:hoist`. With `--check` it writes nothing and exits 1 when
// the committed recording's content differs from a fresh one.
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { jestBabelFingerprint, realJestBabel } from './check.ts'
import { GENERATED, generateLayouts } from './generate.ts'
import {
  JEST_RECORDING_PATH,
  layoutsHash,
  packRecording,
  readRecording,
  recordingText,
} from './jest-recording.ts'

const check = process.argv.slice(2).includes('--check')
const layouts = generateLayouts('jest', GENERATED.jest.count, GENERATED.jest.seed)
const recording = {
  fingerprint: jestBabelFingerprint(),
  layouts: layoutsHash(layouts),
  outputs: layouts.map(realJestBabel),
}
if (check) {
  const committed = readRecording()
  if (committed === undefined || recordingText(committed) !== recordingText(recording)) {
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
