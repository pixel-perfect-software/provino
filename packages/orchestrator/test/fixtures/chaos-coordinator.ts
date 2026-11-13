// The coordinator of `pool-chaos.test.ts`, as a process of its own: it runs a project through
// `runProject` over a real pool and writes each file's outcome to a JSON file. The test starts it
// in a process group of its own and afterwards checks that nothing of that group is left.
//
// Arguments: the project directory, the pool kind, the output file. `CHAOS_POOL` is the rest of
// `RunProjectOptions['pool']` as JSON.
import { writeFileSync } from 'node:fs'
import { type RunPoolOptions, runProject } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { PoolKind } from '@provino/types'
import { PID_RECORDING_ENTRY, runtimeProject } from '../support.ts'

const [dir, kind, out] = process.argv.slice(2) as [string, PoolKind, string]
const pool = JSON.parse(process.env.CHAOS_POOL ?? '{}') as RunPoolOptions

const summary = await runProject(runtimeProject(dir), {
  bus: createReporterBus([]),
  cache: false,
  ...(kind === 'forks' ? { entry: PID_RECORDING_ENTRY } : {}),
  pool: { kind, maxWorkers: 4, ...pool },
})

writeFileSync(
  out,
  JSON.stringify({
    reason: summary.reason,
    files: summary.files.map((file) => ({
      path: file.file.path,
      state: file.state,
      workerExit: file.workerExit ?? null,
      errors: file.errors.map((error) => error.message),
    })),
  }),
)
