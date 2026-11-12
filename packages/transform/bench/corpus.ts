// What the transform benches share: the excalidraw corpus of T3.5 (the committed file list, and
// the source in `.refs/excalidraw`), the median, the seeded generator the generated corpora use and
// the command-line parsing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Manifest {
  readonly repo?: string
  readonly commit: string
  readonly rule?: string
  readonly files: readonly string[]
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Where the corpus source is unless `--root` says otherwise. */
export const DEFAULT_ROOT: string = join(repoRoot, '.refs/excalidraw')

/** The committed file list. */
export const MANIFEST_PATH: string = fileURLToPath(
  new URL('../fixtures/excalidraw.json', import.meta.url),
)

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

/** Every file of the manifest under `root`, read. */
export function readSources(
  root: string,
  manifest: Manifest = readManifest(),
): { readonly filename: string; readonly source: string }[] {
  return manifest.files.map((file) => ({
    filename: join(root, file),
    source: readFileSync(join(root, file), 'utf8'),
  }))
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** mulberry32: a small seeded PRNG, so a generated corpus is the same on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One of `items`, chosen by `next` (a `random` generator). */
export function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T
}

/** A command-line mistake: the message is the one line printed before exiting with code 2. */
export class UsageError extends Error {}

/**
 * A bar flag's value (`--max-*`): `undefined` when the flag is absent, else a finite number above
 * 0. `Number('abc')` is NaN and `NaN > bar` is false, so a mistyped bar must stop the run, not pass.
 */
export function parseBar(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const bar = value.trim() === '' ? Number.NaN : Number(value)
  if (!Number.isFinite(bar) || bar <= 0) {
    throw new UsageError(`--${flag} needs a number above 0, got "${value}"`)
  }
  return bar
}

/** A size flag's value: a positive whole number. */
export function parsePositiveInt(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new UsageError(`--${flag} needs a whole number of 1 or more, got "${value}"`)
  }
  return Number(value)
}

/**
 * Runs `parse` before any work: a `UsageError` (or a `parseArgs` error, which is one too) is
 * written as one line on stderr and the process exits with code 2.
 */
export function parseOrExitUsage<T>(tool: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error instanceof TypeError &&
        String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS_'))
    ) {
      process.stderr.write(`${tool}: ${error.message.split('\n')[0]}\n`)
      process.exit(2)
    }
    throw error
  }
}
