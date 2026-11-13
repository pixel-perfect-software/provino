// Preloaded with `--import` (through NODE_OPTIONS by `runBuilt` in `support.ts`, as a `data:` URL
// of this text: plain JavaScript, no type syntax, so the child never strips types; every process
// the run starts has it): notes
// each module the process loads, as `<argv[1]>\t<url>` lines in `$PROVINO_LOAD_LOG/<pid>.txt`.
// `exports.test.ts` reads the worker's file to count what a worker's cold start loads (T1.10).
// Node 24 has no `node.module` trace category, so the sync `load` hook is the count.
import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const dir = process.env.PROVINO_LOAD_LOG
if (dir !== undefined) {
  const file = `${dir}/${process.pid}.txt`
  registerHooks({
    load(url, context, nextLoad) {
      appendFileSync(file, `${process.argv[1] ?? ''}\t${url}\n`)
      return nextLoad(url, context)
    },
  })
}
