// `pnpm --filter @provino/lazy typeperf --lets 60`: prints one JSON line per compiler.
import { parseArgs } from 'node:util'
import { COMPILERS } from './tsc.ts'
import { DEFAULT_LETS, MAX_INSTANTIATIONS, measure } from './typeperf.ts'

const { values } = parseArgs({
  options: { lets: { type: 'string', default: String(DEFAULT_LETS) } },
})
const lets = Number(values.lets)
if (!Number.isInteger(lets) || lets < 1) {
  console.error(`--lets takes a positive integer, got ${values.lets}`)
  process.exit(2)
}
let failed = false
for (const compiler of COMPILERS) {
  const result = measure(compiler, lets)
  console.log(JSON.stringify({ ...result, max: MAX_INSTANTIATIONS, label: 'local' }))
  failed ||= result.errors > 0 || result.instantiations > MAX_INSTANTIATIONS
}
process.exit(failed ? 1 : 0)
