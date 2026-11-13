// A child process for the V8 cache tests (`test-helpers.ts` → `runChild`): runs one scenario in a
// fresh process, where V8's per-isolate compilation cache and the process-global compile cache are
// clean, and prints the outcome as one line of JSON. Not part of the package's exports.
//
//   test-child.ts load <json>      compile `manyFunctions(n)` through a V8 cache, run it, flush
//   test-child.ts coverage <json>  the same under precise coverage, counting what it reports
//   test-child.ts native <json>    call `enableNativeCompileCache`, optionally against a stand-in

import { Session } from 'node:inspector'
import { constants, createRequire, syncBuiltinESMExports } from 'node:module'
import { Script } from 'node:vm'
import type { CacheMode } from './index.ts'
import { createV8Cache, enableNativeCompileCache, v8CacheTag } from './index.ts'
import { manyFunctions, SCRIPT_NAME } from './test-helpers.ts'

const [command = '', json = '{}'] = process.argv.slice(2)
const scenario = JSON.parse(json) as Record<string, unknown>
const dir = String(scenario.dir)
const mode = (scenario.mode ?? 'on') as CacheMode
const key = String(scenario.key)
const code = manyFunctions(Number(scenario.functions ?? 100))

function print(value: object): void {
  process.stdout.write(JSON.stringify(value))
}

if (command === 'load') {
  const cache = createV8Cache({ dir, mode })
  const script = cache.loadScript(code, SCRIPT_NAME, key)
  const result: unknown = script.runInThisContext()
  if (scenario.flush !== false) await cache.flush()
  print({
    stats: cache.stats,
    cachedDataRejected: script.cachedDataRejected ?? null,
    result,
    tag: v8CacheTag(),
  })
} else if (command === 'coverage') {
  const session = new Session()
  session.connect()
  const post = (method: string, params?: object): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      session.post(method, params, (error, value) =>
        error === null ? resolve((value ?? {}) as Record<string, unknown>) : reject(error),
      )
    })
  await post('Profiler.enable')
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
  const cache = createV8Cache({ dir, mode })
  const script =
    scenario.how === 'plain'
      ? new Script(code, { filename: SCRIPT_NAME })
      : cache.loadScript(code, SCRIPT_NAME, key)
  const result: unknown = script.runInThisContext()
  const taken = await post('Profiler.takePreciseCoverage')
  interface Entry {
    readonly url: string
    readonly functions: readonly { readonly isBlockCoverage: boolean; readonly ranges: unknown[] }[]
  }
  const entry = (taken.result as Entry[]).find((one) => one.url.endsWith(SCRIPT_NAME))
  const functions = entry?.functions ?? []
  print({
    functions: functions.length,
    ranges: functions.reduce((sum, one) => sum + one.ranges.length, 0),
    blockFunctions: functions.filter((one) => one.isBlockCoverage).length,
    stats: cache.stats,
    cachedDataRejected: script.cachedDataRejected ?? null,
    result,
  })
} else if (command === 'native') {
  const node = createRequire(import.meta.url)('node:module') as Record<string, unknown>
  const calls: string[] = []
  const status = constants.compileCacheStatus
  switch (scenario.fake) {
    case 'missing':
      node.enableCompileCache = undefined
      break
    case 'throws':
      node.enableCompileCache = () => {
        throw new Error('no cache for you')
      }
      break
    case 'failed':
      node.enableCompileCache = () => ({ status: status.FAILED, message: 'cannot create it' })
      break
    case 'object-throws':
      // Node 22's refusal of the object form: the call falls back to the string.
      node.enableCompileCache = (argument: unknown) => {
        calls.push(typeof argument)
        if (typeof argument !== 'string') throw new TypeError('ERR_INVALID_ARG_TYPE')
        return { status: status.ENABLED, directory: argument }
      }
      break
    default:
  }
  syncBuiltinESMExports()
  const first = enableNativeCompileCache(dir, mode)
  const second = enableNativeCompileCache(dir, mode)
  print({ first, second, calls })
} else {
  throw new Error(`unknown command ${command}`)
}
