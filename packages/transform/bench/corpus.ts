// What the transform benches share: the excalidraw corpus of T3.5 (the committed file list, and
// the source in `.refs/excalidraw`), and the median.
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
