// What both sidecar reporters (`src/reporters/`) write: one JSON line per console write, appended to
// one file. They are loaded by absolute path from a repository's own Jest or Vitest config, which
// can't resolve any `@provino/*` package (the exports have no default condition and the repository
// has no link to this one), so this file and the two reporters import Node builtins and each other
// only. `src/sidecar.ts` re-exports the public parts and reads the file back.
import { appendFileSync, writeFileSync } from 'node:fs'

/**
 * The environment variable that names the file the sidecar reporters write.
 * @public
 */
export const SIDECAR_ENV: string = 'PROVINO_SIDECAR_OUT'

/**
 * One console write, as a sidecar reporter records it. `text` is what the runner captured, unsplit
 * and unnormalized; the harness's converters split it into lines and normalize each one.
 * @public
 */
export interface SidecarEntry {
  /** The test file, as the runner names it (an absolute path). Absent when the runner can't say. */
  readonly file?: string
  /**
   * The test the write happened in: its title path and its index among tests with the same file
   * and path, in declaration order. Only Vitest attributes output to a test; absent for output
   * outside a test (a `beforeAll`, a module's top level) and for every Jest entry.
   */
  readonly test?: { readonly path: readonly string[]; readonly dupIndex: number }
  readonly stream: 'stdout' | 'stderr'
  /** The console method (`log`, `warn`…), when the runner reports it (Jest does, Vitest doesn't). */
  readonly level?: string
  readonly text: string
}

/**
 * What a sidecar reporter takes from its config entry (`['<path>', { outputFile }]`). Without an
 * `outputFile` it writes to the file in `PROVINO_SIDECAR_OUT`.
 * @public
 */
export interface SidecarOptions {
  readonly outputFile?: string
}

/**
 * Starts the sidecar file empty and returns the function that appends one entry to it. The file is
 * the reporter's own, so an empty file means the run printed nothing and a missing one means the
 * reporter never loaded. Throws when no file is named, because a reporter that writes nowhere would
 * pass for a run with no console output.
 * @internal
 */
export function openSidecar(
  options: SidecarOptions | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): (entry: SidecarEntry) => void {
  const file = options?.outputFile ?? env[SIDECAR_ENV]
  if (file === undefined || file === '') {
    throw new Error(
      `the Provino sidecar reporter needs a file to write: set ${SIDECAR_ENV} or pass { outputFile }`,
    )
  }
  writeFileSync(file, '')
  return (entry) => {
    // Synchronous, so lines land in the order the runner reported them and none is lost on exit.
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  }
}

// Node's `Console` writes these to stderr and everything else to stdout; Vitest captures through a
// `Console`, so Jest's levels are mapped the same way and the two runners' streams agree.
const STDERR_LEVELS: ReadonlySet<string> = new Set(['error', 'warn', 'trace', 'assert'])

/**
 * The stream a console method writes to under Node's `Console`.
 * @internal
 */
export function streamOfLevel(level: string): SidecarEntry['stream'] {
  return STDERR_LEVELS.has(level) ? 'stderr' : 'stdout'
}
