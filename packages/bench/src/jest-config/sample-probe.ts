// One side's read of one sample config, in its own process (`sample-run.ts` spawns it with the
// network guard preloaded, the permission model on, and a timeout). Its working directory is the
// config's directory, as `jest` run there would have. The outcome (an encoded read, or the error
// text) is written as JSON to the result file; stdout and stderr are the config's own.
//
// Usage: node --conditions=provino-source --import <guard> sample-probe.ts jest|provino <config> <out>
import { writeFileSync } from 'node:fs'
import { readWithJest, readWithProvino } from './oracle.ts'

const [side, config, out] = process.argv.slice(2)
if ((side !== 'jest' && side !== 'provino') || config === undefined || out === undefined) {
  throw new Error('usage: sample-probe.ts jest|provino <config> <out>')
}
const outcome = side === 'jest' ? await readWithJest(config) : await readWithProvino(config)
writeFileSync(out, JSON.stringify(outcome))
// A config can leave handles open (a watcher, a timer); the read is done.
process.exit(0)
