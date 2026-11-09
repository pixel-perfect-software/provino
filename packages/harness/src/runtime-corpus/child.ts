// The child process of the runtime corpus's error fixtures: `node --conditions=provino-source
// child.ts <file> <rootDir> <profile> <out>` runs one fixture file through core with core
// listening for the process's uncaught exceptions and rejections, and writes the `CoreRun` as JSON
// to `<out>`. In the harness's own test process `node:test` has handlers of its own for those.
import { writeFile } from 'node:fs/promises'
import { corePolicyFor } from './profiles.ts'
import { runUnderCore } from './run-core.ts'

const [file, rootDir, profile, out] = process.argv.slice(2)
if (file === undefined || rootDir === undefined || out === undefined) {
  throw new Error('usage: child.ts <file> <rootDir> <profile> <out>')
}
if (profile !== 'jest' && profile !== 'vitest' && profile !== 'vitest-list') {
  throw new Error(`unknown profile: ${String(profile)}`)
}
const run = await runUnderCore(file, rootDir, corePolicyFor[profile], { processErrors: true })
await writeFile(out, JSON.stringify(run))
