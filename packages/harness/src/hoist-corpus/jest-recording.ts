// Real Babel's output for the Jest generated layouts, recorded (`__goldens__/jest-generated.json.gz`):
// two Babel passes a layout over 3,000 layouts were most of the hoist check's time. Everything the
// check compares is still read from these texts as the test runs (`check.ts` `referenceJest`); only
// Babel itself is not run again. The recording names the layouts (a hash of each one's name, file
// and code) and Babel's fingerprint (`jestBabelFingerprint`: the pinned versions and both option
// sets), and the test refuses it when either differs. Re-record with
// `pnpm --filter @provino/harness record:hoist` (`record-jest.ts`; `--check` writes nothing).
// Gzipped: the outputs repeat Babel's helpers, 2 MB as text, under 100 kB packed.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { isRecord, prop } from '../internal/guards.ts'
import type { HoistCase, JestBabelOutput } from './check.ts'

/** Where the recording is. */
export const JEST_RECORDING_PATH: string = fileURLToPath(
  new URL('./__goldens__/jest-generated.json.gz', import.meta.url),
)

/** The recording: Babel's output for each layout, in order. */
export interface JestRecording {
  readonly fingerprint: string
  readonly layouts: string
  readonly outputs: readonly JestBabelOutput[]
}

/** The sha256 of the layouts, so a recording of other layouts is refused. */
export function layoutsHash(layouts: readonly HoistCase[]): string {
  const hash = createHash('sha256')
  for (const { name, filename, jsx, code } of layouts) {
    hash.update(JSON.stringify([name, filename, jsx ?? null, code]))
  }
  return hash.digest('hex')
}

/** The recording as text: one output a line, so two recordings compare line by line. */
export function recordingText(recording: JestRecording): string {
  const lines = recording.outputs.map((output) => `    ${JSON.stringify(output)}`)
  return `{\n  "fingerprint": ${JSON.stringify(recording.fingerprint)},\n  "layouts": ${JSON.stringify(recording.layouts)},\n  "outputs": [\n${lines.join(',\n')}\n  ]\n}\n`
}

/** The packed file's bytes. */
export function packRecording(recording: JestRecording): Buffer {
  return gzipSync(recordingText(recording), { level: 9 })
}

function isBabelOutput(value: unknown): value is JestBabelOutput {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort().join(',')
  if (keys === 'error') return typeof prop(value, 'error') === 'string'
  return (
    keys === 'commonjs,hoisted' &&
    typeof prop(value, 'hoisted') === 'string' &&
    typeof prop(value, 'commonjs') === 'string'
  )
}

/** Reads the recording, checking its shape; `undefined` when there is none. */
export function readRecording(path: string = JEST_RECORDING_PATH): JestRecording | undefined {
  let packed: Buffer
  try {
    packed = readFileSync(path)
  } catch {
    return undefined
  }
  const json: unknown = JSON.parse(gunzipSync(packed).toString('utf8'))
  const fingerprint = isRecord(json) ? prop(json, 'fingerprint') : undefined
  const layouts = isRecord(json) ? prop(json, 'layouts') : undefined
  const outputs = isRecord(json) ? prop(json, 'outputs') : undefined
  if (
    typeof fingerprint !== 'string' ||
    typeof layouts !== 'string' ||
    !Array.isArray(outputs) ||
    !outputs.every(isBabelOutput)
  ) {
    throw new TypeError(`${path} is not a recording of the Jest layouts`)
  }
  return { fingerprint, layouts, outputs }
}
