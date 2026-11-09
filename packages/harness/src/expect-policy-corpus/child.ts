// The child process of the policy corpus: `node --conditions=provino-source child.ts <file>
// <rootDir> <profile> <flip|-> <out>` runs one fixture file through core, with core listening for the
// process's uncaught exceptions and rejections, and writes its tests as JSON to `<out>`. In the
// harness's own test process `node:test` has handlers of its own for those.
import { writeFile } from 'node:fs/promises'
import { FLIPS, type PolicyFlip, policyFor } from './profiles.ts'
import { runPolicyFile } from './run-policy.ts'

const [file, rootDir, profile, flip, out] = process.argv.slice(2)
if (file === undefined || rootDir === undefined || flip === undefined || out === undefined) {
  throw new Error('usage: child.ts <file> <rootDir> <profile> <flip|-> <out>')
}
if (profile !== 'jest' && profile !== 'vitest') {
  throw new Error(`unknown profile: ${String(profile)}`)
}
if (flip !== '-' && !Object.hasOwn(FLIPS, flip)) throw new Error(`unknown flip: ${flip}`)
const policy = policyFor(profile, flip === '-' ? undefined : (flip as PolicyFlip))
await writeFile(out, JSON.stringify(await runPolicyFile(file, rootDir, policy)))
