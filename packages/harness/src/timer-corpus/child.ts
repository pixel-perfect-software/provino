// The child process of the timer corpus: `node --conditions=provino-source child.ts <file>
// <rootDir> <profile> <out>` runs one fixture file through core with the fake clock on this
// process's real global and writes the `CoreRun` as JSON to `<out>`. A run that fakes
// `Date`, `setTimeout`, `nextTick` and the rest is not safe in the harness's own test process.
import { writeFile } from 'node:fs/promises'
import { mockPolicyFor } from '../mock-corpus/profiles.ts'
import { corePolicyFor } from '../runtime-corpus/profiles.ts'
import { timersPolicyFor } from './profiles.ts'
import { runTimerFile } from './run-timers.ts'

const [file, rootDir, profile, out] = process.argv.slice(2)
if (file === undefined || rootDir === undefined || out === undefined) {
  throw new Error('usage: child.ts <file> <rootDir> <profile> <out>')
}
if (profile !== 'jest' && profile !== 'vitest' && profile !== 'vitest-list') {
  throw new Error(`unknown profile: ${String(profile)}`)
}
const run = await runTimerFile(
  file,
  rootDir,
  corePolicyFor[profile],
  mockPolicyFor[profile],
  timersPolicyFor[profile],
  profile === 'jest' ? 'jest' : 'vi',
)
await writeFile(out, JSON.stringify(run))
