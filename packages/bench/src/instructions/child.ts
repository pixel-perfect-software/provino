#!/usr/bin/env node
// One leg of `provino-bench instructions` in a process of its own. Usage:
//   child.ts <leg> <work dir> [<plant iterations>]
//   child.ts warm-fill <work dir>
// It runs the leg's workload once (then `plantedWork(iterations)` when a plant is asked for) and
// prints `PROVINO_SAMPLE {"ok", "ms", "units", "detail"}`; exit 0 when the work was correct, 1 when
// not. The parent runs it under cachegrind for the instruction count and plainly for the wall
// signal, on Provino's built packages (no `provino-source` condition), so this file and what it
// imports never reach `@provino/harness`.
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { legOf } from './legs.ts'
import { fillWarmCache, plantedWork, runWorkload, type WorkloadResult } from './workloads.ts'

const [name = '', work = '', plantText = '0'] = process.argv.slice(2)
const plant = Number(plantText)
let result: WorkloadResult
if (name === 'warm-fill') {
  result = fillWarmCache(work)
} else {
  const leg = legOf(name)
  if (leg === undefined || work === '' || !Number.isSafeInteger(plant) || plant < 0) {
    process.stderr.write('usage: child.ts <leg> <work dir> [<plant iterations>]\n')
    process.exit(2)
  }
  result = await runWorkload(leg.id, work)
  if (plant > 0) {
    const value = plantedWork(plant)
    result = { ...result, detail: `${result.detail}; planted ${plant} iterations (${value})` }
  }
}
process.stdout.write(`${SAMPLE_PREFIX}${JSON.stringify(result)}\n`)
process.exitCode = result.ok ? 0 : 1
