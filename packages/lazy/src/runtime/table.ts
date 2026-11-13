// The definition table (interim, until B25's T5.9 moves it into core): each suite's entries live
// in its `slots` under `TABLE`, one per key. Registration validates what it can at once; what needs
// the whole file (an override's target) is validated when the file is collected.
import type { FileHandle, Scope, SuiteHandle } from '@provino/types'
import { LazyError } from '../errors.ts'
import type { LetOptions, ReservedKey } from '../types.ts'
import { captureSite, formatSite } from './site.ts'
import {
  type DefineFn,
  type Engine,
  type EntryKind,
  FILE_STATE,
  LazyEntry,
  RESOLVED,
  type SuiteTable,
  TABLE,
} from './state.ts'

const RESERVED_LIST = [
  'let',
  'eager',
  'override',
  'from',
  'then',
  'toJSON',
  'toString',
  'valueOf',
  'toLocaleString',
  'constructor',
  '__proto__',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'asymmetricMatch',
  '$$typeof',
  'nodeType',
  '_isMockFunction',
] as const satisfies readonly ReservedKey[]

// Fails to compile when `ReservedKey` has a member the list lacks.
const _complete: Exclude<ReservedKey, (typeof RESERVED_LIST)[number]> extends never ? true : never =
  true
void _complete

const RESERVED: ReadonlySet<string> = new Set<string>(RESERVED_LIST)
const SCOPES: ReadonlySet<string> = new Set<string>(['test', 'file', 'worker'])

interface FileState {
  readonly overrides: LazyEntry[]
}

function tableOf(suite: SuiteHandle): SuiteTable {
  let table = suite.slots.get(TABLE) as SuiteTable | undefined
  if (table === undefined) {
    table = new Map()
    suite.slots.set(TABLE, table)
  }
  return table
}

function ancestorEntry(suite: SuiteHandle, key: string): LazyEntry | undefined {
  for (let s = suite.parent; s !== undefined; s = s.parent) {
    const found = (s.slots.get(TABLE) as SuiteTable | undefined)?.get(key)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The scope of the eager definition an override at `entry` inherits, or `undefined` when the key is
 * not eager there (a `let` of it, or no definition yet around the override).
 */
export function inheritedEagerScope(entry: LazyEntry): Scope | undefined {
  for (let e = ancestorEntry(entry.suite, entry.key); e !== undefined; ) {
    if (e.kindOf === 'eager') return e.declared
    if (e.kindOf === 'let') return undefined
    e = ancestorEntry(e.suite, e.key)
  }
  return undefined
}

/** The file's state; the first registration in a file also hooks its collection-time check. */
function fileState(engine: Engine, file: FileHandle): FileState {
  let state = file.slots.get(FILE_STATE) as FileState | undefined
  if (state === undefined) {
    const created: FileState = { overrides: [] }
    state = created
    file.slots.set(FILE_STATE, created)
    engine.host.onCollected(() => {
      for (const entry of created.overrides) {
        if (ancestorEntry(entry.suite, entry.key) === undefined) {
          throw new LazyError(
            'LAZY_INVALID',
            `\`${entry.key}\` is overridden at ${formatSite(entry.site)}, but no suite around it defines it. Define it with lazy.let('${entry.key}', …) in an outer describe or at the top of the file.`,
            { site: entry.site },
          )
        }
      }
    })
  }
  return state
}

/** Fixes what depends on the whole table: the parent entry, scope, eagerness and the memo key. */
export function settle(entry: LazyEntry): LazyEntry {
  if (entry.settled) return entry
  const parent = ancestorEntry(entry.suite, entry.key)
  if (parent !== undefined) settle(parent)
  entry.parentEntry = parent ?? null
  if (entry.override) {
    entry.scope = parent?.scope ?? 'test'
    entry.eager = parent?.eager ?? false
  } else {
    entry.scope = entry.declared ?? 'test'
    entry.eager = entry.kindOf === 'eager'
  }
  entry.memo =
    entry.scope === 'worker' ? Symbol.for(`provino.lazy.worker:${entry.id}`) : Symbol(entry.id)
  entry.settled = true
  return entry
}

/** The entry that answers `key` for `suite`: its own, else the nearest outer suite's. */
export function resolveEntry(suite: SuiteHandle, key: string): LazyEntry {
  // The cached hit is the read path's: kept small for V8 to inline; the walk is `resolveCold`.
  const cache = suite.slots.get(RESOLVED) as Map<string, LazyEntry> | undefined
  if (cache !== undefined) {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
  }
  return resolveCold(suite, key, cache)
}

/** The first resolution of `key` for `suite`: walks outward, settles the entry and caches it. */
function resolveCold(
  suite: SuiteHandle,
  key: string,
  known: Map<string, LazyEntry> | undefined,
): LazyEntry {
  let cache = known
  for (let s: SuiteHandle | undefined = suite; s !== undefined; s = s.parent) {
    const found = (s.slots.get(TABLE) as SuiteTable | undefined)?.get(key)
    if (found !== undefined) {
      settle(found)
      if (cache === undefined) {
        cache = new Map()
        suite.slots.set(RESOLVED, cache)
      }
      cache.set(key, found)
      return found
    }
  }
  throw new LazyError(
    'LAZY_UNDEFINED',
    `\`${key}\` is not defined for this test: no lazy.let('${key}', …) in "${suite.name}" or any suite around it.`,
  )
}

/** Every key a definition in `suite` can read: the keys of the suite and of all around it. */
export function visibleKeys(suite: SuiteHandle): string[] {
  const keys = new Set<string>()
  for (let s: SuiteHandle | undefined = suite; s !== undefined; s = s.parent) {
    const table = s.slots.get(TABLE) as SuiteTable | undefined
    if (table !== undefined) for (const key of table.keys()) keys.add(key)
  }
  return [...keys]
}

/** Registers one definition into the suite being collected. */
export function register(
  engine: Engine,
  kind: EntryKind,
  key: string,
  define: DefineFn,
  options: LetOptions<Scope> | undefined,
  apiFn: (...args: never[]) => unknown,
): LazyEntry {
  const site = captureSite(apiFn)
  const api = kind === 'override' ? 'override' : kind === 'eager' ? 'lazy.eager' : 'lazy.let'
  const suite = engine.host.collecting()
  if (suite === undefined) {
    throw new LazyError(
      'LAZY_NOT_COLLECTING',
      `${api}('${String(key)}', …) only works while a describe body, or the top of the file, is being collected. It cannot run inside a test or a hook.`,
      { site },
    )
  }
  if (typeof key !== 'string' || key === '') {
    throw new LazyError('LAZY_INVALID', `${api} needs a non-empty string key`, { site })
  }
  if (RESERVED.has(key)) {
    throw new LazyError('LAZY_RESERVED', `'${key}' is reserved and cannot be a lazy key`, { site })
  }
  if (typeof define !== 'function') {
    throw new LazyError('LAZY_INVALID', `${api}('${key}', …) needs a function to define it`, {
      site,
    })
  }
  const declared = kind === 'override' ? undefined : (options?.scope ?? 'test')
  if (declared !== undefined && !SCOPES.has(declared)) {
    throw new LazyError('LAZY_INVALID', `'${String(declared)}' is not a scope of '${key}'`, {
      site,
    })
  }
  const timeout = options?.timeout
  if (timeout !== undefined && !(typeof timeout === 'number' && timeout > 0)) {
    throw new LazyError('LAZY_INVALID', `the timeout of '${key}' must be a number above 0`, {
      site,
    })
  }
  if (declared !== undefined && declared !== 'test' && suite !== suite.file.root) {
    throw new LazyError(
      'LAZY_INVALID',
      `'${key}' has scope '${declared}', which is only allowed at the top level of a test file, not inside a describe.`,
      { site },
    )
  }
  const table = tableOf(suite)
  const existing = table.get(key)
  if (existing !== undefined) {
    throw new LazyError(
      'LAZY_DUPLICATE',
      `'${key}' is defined twice in "${suite.name}": at ${formatSite(existing.site)} and at ${formatSite(site)}. Override it in a nested describe instead.`,
      { sites: [site, existing.site] },
    )
  }
  const entry = new LazyEntry(
    key,
    kind,
    declared,
    define,
    timeout,
    suite,
    site,
    `${formatSite(site)}#${key}`,
  )
  const state = fileState(engine, suite.file)
  table.set(key, entry)
  if (kind === 'override') state.overrides.push(entry)
  return entry
}
