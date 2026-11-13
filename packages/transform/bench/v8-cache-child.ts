// The child process of `pnpm bench:v8-cache` (`v8-cache.ts`): one measurement in a fresh process,
// printed as one line of JSON. A fresh process is the point: V8 keeps a compilation cache per
// isolate, so a second compile of the same source in one process measures that cache, not the code
// cache. Not part of the package's exports.
//
//   v8-cache-child.ts <variant> <cache dir> <script path> <key>
//
//   plain   `new vm.Script(code)`, then the script's top level
//   fill    `createV8Cache(...).loadScript` against an empty directory (a miss), the top level, a
//           flush: the entry the `cached` runs read (the parent discards its timings)
//   cached  `loadScript` against the filled directory; fails unless V8 accepted the entry
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { Script } from 'node:vm'
import { createV8Cache } from '@provino/transform/v8cache'

const [variant = '', dir = '', path = '', key = ''] = process.argv.slice(2)
// The source is read before the clock starts: reading it is not what is being compared.
const code = readFileSync(path, 'utf8')

function fail(message: string): never {
  process.stderr.write(`v8-cache-child (${variant}): ${message}\n`)
  process.exit(1)
}

/** The top level of `typescript.js` defines the compiler's namespace; it needs no `require`. */
function runTopLevel(script: Script): number {
  const start = performance.now()
  script.runInThisContext()
  return performance.now() - start
}

if (variant === 'plain') {
  const start = performance.now()
  const script = new Script(code, { filename: path })
  const compileMs = performance.now() - start
  process.stdout.write(JSON.stringify({ compileMs, runMs: runTopLevel(script) }))
} else if (variant === 'fill' || variant === 'cached') {
  const cache = createV8Cache({ dir })
  const start = performance.now()
  const script = cache.loadScript(code, path, key)
  const compileMs = performance.now() - start
  const runMs = runTopLevel(script)
  await cache.flush()
  const { stats } = cache
  if (variant === 'fill' && (stats.misses !== 1 || stats.written !== 1)) {
    fail(`expected a miss and a write, got ${JSON.stringify(stats)}`)
  }
  if (variant === 'cached') {
    // A hit that V8 refused (or never consumed) is not a result: fail loudly.
    if (stats.hits !== 1 || stats.rejected !== 0 || script.cachedDataRejected !== false) {
      fail(
        `expected a hit V8 accepted, got ${JSON.stringify(stats)} (cachedDataRejected ${String(script.cachedDataRejected)})`,
      )
    }
  }
  process.stdout.write(JSON.stringify({ compileMs, runMs, stats }))
} else {
  fail(`unknown variant "${variant}"`)
}
