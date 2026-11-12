// The pool's reuse test (Track 9 §Pool 2): a warm worker takes the next file only when everything
// that makes a worker what it is matches.
import { hash } from 'node:crypto'
import type { JsonValue, PoolKind, WorkerKey } from '@provino/types'

/** JSON with every object's keys sorted, so the same data always gives the same text. */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item as JsonValue)).join(',')}]`
  const record = value as { readonly [key: string]: JsonValue | undefined }
  const entries = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const item = record[key]
      // `JSON.stringify` drops a key whose value is `undefined`; so does this.
      return item === undefined ? [] : [`${JSON.stringify(key)}:${stableJson(item)}`]
    })
  return `{${entries.join(',')}}`
}

/** A SHA-1 over `value`'s stable JSON, in hex. Identity, not security. */
export function hashOf(value: JsonValue): string {
  return hash('sha1', stableJson(value))
}

/**
 * What a worker is started with, as far as reuse is concerned.
 * @public
 */
export interface WorkerKeyInput {
  readonly project: string
  readonly pool: PoolKind
  /** The environment's name. */
  readonly environment: string
  /** The options the environment gets (`EnvironmentRef.options`). */
  readonly environmentOptions: { readonly [key: string]: JsonValue }
  /** The Node flags the worker runs with. */
  readonly execArgv: readonly string[]
  /** The environment variables set for the worker on top of the coordinator's. Default none. */
  readonly env?: { readonly [name: string]: string }
}

/**
 * The key of a worker. Its three hashes are SHA-1s of stable JSON (object keys sorted), so two
 * option objects with the same entries in another order give the same key, and `execArgv`, an
 * ordered list, does not.
 * @public
 */
export function workerKeyOf(input: WorkerKeyInput): WorkerKey {
  return {
    project: input.project,
    pool: input.pool,
    environment: input.environment,
    environmentOptionsHash: hashOf(input.environmentOptions),
    execArgvHash: hashOf([...input.execArgv]),
    envHash: hashOf(input.env ?? {}),
  }
}

/**
 * Whether a worker started for `a` can take a file that wants `b`.
 * @public
 */
export function sameWorkerKey(a: WorkerKey, b: WorkerKey): boolean {
  return (
    a.project === b.project &&
    a.pool === b.pool &&
    a.environment === b.environment &&
    a.environmentOptionsHash === b.environmentOptionsHash &&
    a.execArgvHash === b.execArgvHash &&
    a.envHash === b.envHash
  )
}

/** A string equal for exactly the keys `sameWorkerKey` calls the same, for a `Map`. */
export function workerKeyId(key: WorkerKey): string {
  return `${key.project}\0${key.pool}\0${key.environment}\0${key.environmentOptionsHash}\0${key.execArgvHash}\0${key.envHash}`
}

/** `value` as JSON-like data: regular expressions as their text, sets as sorted lists, functions dropped. */
function plain(value: unknown): unknown {
  if (value instanceof RegExp) return value.toString()
  if (value instanceof Set) return [...value].map(String).sort()
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  }
  return typeof value === 'function' ? undefined : value
}

/** A hash of a finished project config, by its content: equal for byte-identical configs, whatever their key order. */
export function configHash(config: unknown): string {
  return hashOf(plain(config) as JsonValue)
}
