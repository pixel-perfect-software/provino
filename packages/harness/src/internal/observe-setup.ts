// The setup file that installs `globalThis.observe(id, run)`, the recorder's second global after
// `trace`. A case runs `run`, reduces what it returned (or threw) to JSON by the rules below, and
// traces one line: `{"id":..., "value":...}` or `{"id":..., "threw":...}`. The golden's `trace`
// is then the list of observations, in call order, in the one golden format.
//
// This file is loaded as a setup file by Jest (as CommonJS), Vitest (as ESM) and the corpus
// checks, so it is one copy for every runner. It has no import and no export, only erasable
// types, and it never uses `instanceof` or a runner's own `Error`, because Jest runs a test file
// in a vm context whose `Error`, `Array` and `Promise` are not the ones of the code under test.
// The reduction:
//   undefined          {"$":"undefined"}
//   number             itself, or {"$":"number","value":"NaN"|"Infinity"|"-Infinity"|"-0"}
//   bigint, symbol     {"$":"bigint","value":"1"} and {"$":"symbol","value":"description"}
//   function           {"$":"function","name":...}
//   error              {"$":"error","name":...,"message":...} (no stack: it holds paths)
//   promise            {"$":"promise"} (observe awaits its own `run`, so only a nested one shows)
//   Map, Set, Date, RegExp   {"$":"map","entries":[...]} and so on
//   array and object   by own enumerable string keys in order; a getter that throws shows as
//                      {"$":"threw",...}; a cycle as {"$":"circular"}; more than 8 deep {"$":"deep"}
// Nothing else is reduced: a symbol key is dropped, and a class instance is its own fields.
{
  const MAX_DEPTH = 8
  const target = globalThis as {
    trace?: (step: string) => void
    observe?: (id: string, run: () => unknown) => Promise<void>
  }

  const tagOf = (value: unknown): string => Object.prototype.toString.call(value)

  const isError = (value: object): boolean => {
    if (tagOf(value) === '[object Error]') return true
    const candidate = value as { name?: unknown; message?: unknown; stack?: unknown }
    return (
      typeof candidate.name === 'string' &&
      typeof candidate.message === 'string' &&
      typeof candidate.stack === 'string'
    )
  }

  const reduce = (value: unknown, seen: readonly object[], depth: number): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (value === undefined) return { $: 'undefined' }
    if (typeof value === 'number') {
      if (Object.is(value, -0)) return { $: 'number', value: '-0' }
      return Number.isFinite(value) ? value : { $: 'number', value: String(value) }
    }
    if (typeof value === 'bigint') return { $: 'bigint', value: String(value) }
    if (typeof value === 'symbol') return { $: 'symbol', value: value.description ?? '' }
    if (typeof value === 'function') return { $: 'function', name: value.name }
    if (isError(value)) {
      const error = value as { name: string; message: string }
      return { $: 'error', name: error.name, message: error.message }
    }
    if (tagOf(value) === '[object Promise]') return { $: 'promise' }
    if (seen.includes(value)) return { $: 'circular' }
    if (depth >= MAX_DEPTH) return { $: 'deep' }
    const path = [...seen, value]
    const next = (inner: unknown): unknown => reduce(inner, path, depth + 1)
    const tag = tagOf(value)
    if (Array.isArray(value)) return value.map(next)
    if (tag === '[object Map]') {
      const entries = [...(value as Map<unknown, unknown>)].map(([k, v]) => [next(k), next(v)])
      return { $: 'map', entries }
    }
    if (tag === '[object Set]') return { $: 'set', values: [...(value as Set<unknown>)].map(next) }
    if (tag === '[object Date]') {
      const time = (value as Date).getTime()
      return {
        $: 'date',
        value: Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString(),
      }
    }
    if (tag === '[object RegExp]') return { $: 'regexp', value: String(value) }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      try {
        out[key] = next((value as Record<string, unknown>)[key])
      } catch (error) {
        out[key] = { $: 'threw', error: reduce(error, path, depth + 1) }
      }
    }
    return out
  }

  target.observe = async (id: string, run: () => unknown): Promise<void> => {
    const trace = target.trace
    if (trace === undefined) throw new Error('observe needs the trace setup to run first')
    if (typeof id !== 'string' || id === '') throw new Error('observe needs a non-empty id')
    let line: string
    try {
      line = JSON.stringify({ id, value: reduce(await run(), [], 0) })
    } catch (error) {
      line = JSON.stringify({ id, threw: reduce(error, [], 0) })
    }
    trace(line)
  }
}
