// One side's read of one sample config, in its own process (`sample-run.ts` spawns it with the
// network guard preloaded, the permission model on, and a timeout). Its working directory is the
// config's directory. The outcome is written as JSON to the result file; stdout and stderr are
// the config's own.
//
// Usage: node --conditions=provino-source --import <guard> sample-probe.ts vitest|provino|defaults <config|root> <out>
import { writeFileSync } from 'node:fs'
import { readWithProvino, readWithVitest } from './oracle.ts'

const [side, target, out] = process.argv.slice(2)
if (
  (side !== 'vitest' && side !== 'provino' && side !== 'defaults') ||
  target === undefined ||
  out === undefined
) {
  throw new Error('usage: sample-probe.ts vitest|provino|defaults <config|root> <out>')
}
// What Vitest derives from the clock and the process is pinned at its source, on both sides (the
// shuffle seed is `Date.now()`; a localstorage path holds the process id), so nothing is masked.
Date.now = () => 1_700_000_000_000

const outcome =
  side === 'defaults'
    ? await readWithVitest(null, target)
    : side === 'vitest'
      ? await readWithVitest(target, process.cwd())
      : await readWithProvino(target)
const pid = new RegExp(`(?<!\\d)${process.pid}(?!\\d)`, 'g')
writeFileSync(out, JSON.stringify(outcome).replace(pid, '<pid>'))
// A config can leave handles open (a watcher, a timer); the read is done.
process.exit(0)
