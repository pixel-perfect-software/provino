// Test helpers for the Jest config reader: file trees written to `$TMPDIR` at test time (a tree is
// data, gap 13 of `bundles/B14.md`; no `.js` is committed, D13), the oracle (real `jest-config`
// 30.5.2, in-process), and a comparable form of a config value.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import type { JestRequireResolve } from '../resolution.ts'

/** A file tree as data: relative path → contents. */
export type Tree = Readonly<Record<string, string>>

/** Writes a tree into a fresh temp dir (its real path) and returns the dir. */
export function writeTree(tree: Tree, prefix = 'provino-jest-config-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  for (const [path, contents] of Object.entries(tree)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

/** Removes a tree `writeTree` made. */
export function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

/** jest-config's own location: Jest's built-in packages resolve from here. */
export const JEST_CONFIG_ENTRY: string = realpathSync(
  fileURLToPath(import.meta.resolve('jest-config')),
)

/** `require.resolve` from jest-config's install, as the oracle's own `require.resolve` does. */
export const oracleRequireResolve: JestRequireResolve = (specifier) => {
  try {
    return createRequire(JEST_CONFIG_ENTRY).resolve(specifier)
  } catch {
    return undefined
  }
}

/** The oracle: real jest-config 30.5.2. */
export interface Oracle {
  readConfig(argv: object, packageRootOrConfig: unknown, ...rest: unknown[]): Promise<unknown>
  readConfigs(argv: object, projectPaths: readonly string[]): Promise<unknown>
  readInitialOptions(config?: string, options?: object): Promise<unknown>
  readonly defaults: Readonly<Record<string, unknown>>
}

/** Loads the oracle. */
export async function loadOracle(): Promise<Oracle> {
  return (await import('jest-config')) as unknown as Oracle
}

/** The `argv` the oracle is called with for a plain `jest` run. */
export const ORACLE_ARGV: Readonly<{ _: never[]; $0: string }> = Object.freeze({
  _: [],
  $0: 'jest',
})

/**
 * A value in a form `deepStrictEqual` can compare across two loads of the same config: functions
 * as their source, a `RegExp` as its source and flags, `undefined` kept as a marker, and a
 * `TestPathPatterns` as its patterns.
 */
export function comparable(value: unknown, seen: readonly object[] = []): unknown {
  if (value === undefined) return { $undefined: true }
  if (typeof value === 'function') return { $function: value.toString() }
  if (typeof value === 'symbol') return { $symbol: String(value) }
  if (typeof value === 'bigint') return { $bigint: String(value) }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  if (typeof value !== 'object' || value === null) return value
  if (seen.includes(value)) return { $circular: true }
  const inner = [...seen, value]
  if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags }
  if (Array.isArray(value)) return value.map((item: unknown) => comparable(item, inner))
  if (value.constructor?.name === 'TestPathPatterns') {
    return comparable(Reflect.get(value, 'patterns'), inner)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = comparable(Reflect.get(value, key), inner)
  return out
}

/** A record's keys, minus `skip`, in comparable form. */
export function comparableWithout(
  value: unknown,
  skip: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = comparable(value) as Record<string, unknown>
  for (const key of skip) delete record[key]
  return record
}

/** An error's message without ANSI colours (Jest colours its validation errors). */
export function plainMessage(error: unknown): string {
  return stripVTControlCharacters(error instanceof Error ? error.message : String(error))
}

/** Runs `fn` with `console.warn` captured; returns its value (or error) and the warnings. */
export async function captureWarnings<T>(fn: () => Promise<T>): Promise<{
  readonly result: T | undefined
  readonly error: unknown
  readonly warnings: string[]
}> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(stripVTControlCharacters(args.map(String).join(' ')))
  }
  try {
    return { result: await fn(), error: undefined, warnings }
  } catch (error) {
    return { result: undefined, error, warnings }
  } finally {
    console.warn = original
  }
}

/** Runs `fn` with the process's working directory set to `dir`. */
export async function inDirectory<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(before)
  }
}
