import type {
  ConsoleEntry,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  SnapshotCounters,
  SnapshotFileState,
} from '@provino/types'
import { toRelativePath } from './internal/convert.ts'
import { byFile } from './internal/guards.ts'
import { createNormalizer, type Normalizer } from './normalize.ts'
import { parseNormalizedRun } from './parse-normalized-run.ts'

/**
 * Options for `convertProvino`.
 * @public
 */
export interface ProvinoConvertOptions {
  /** Absolute: the directory Provino ran in, which becomes `<root>` in normalized text. */
  readonly rootDir: string
  /** Other roots to replace with `<root>`. */
  readonly extraRoots?: readonly string[]
  /** The corpus or fixture id. Provino names the suite after its root directory; this replaces it. */
  readonly suite?: string
  /**
   * The snapshot files the run left, hashed by the caller. Without them the run keeps what Provino
   * wrote (today nothing: `normalized-json` has no snapshot state yet).
   */
  readonly snapshotFiles?: readonly SnapshotFileState[]
  /** Collects the ids of the normalization rules that changed any text. */
  readonly fired?: Set<string>
}

const NO_COUNTERS: SnapshotCounters = {
  added: 0,
  matched: 0,
  unmatched: 0,
  updated: 0,
  unchecked: 0,
  total: 0,
  filesAdded: 0,
  filesRemoved: 0,
  filesUnmatched: 0,
  filesUpdated: 0,
}

function renormalize(error: NormalizedError, normalizer: Normalizer, fired?: Set<string>) {
  // `raw` is the error's stack (else its message), which holds the message the runner printed and
  // its frames; the harness's rules derive the comparable parts from it, as for Jest and Vitest.
  const { name, message, userFrame } = normalizer.error(error.raw, error.matcher, fired)
  return {
    ...(name === undefined ? {} : { name }),
    message,
    ...(error.matcher === undefined ? {} : { matcher: error.matcher }),
    ...(userFrame === undefined ? {} : { userFrame }),
    raw: error.raw,
  }
}

function renormalizeConsole(
  entries: readonly ConsoleEntry[] | undefined,
  normalizer: Normalizer,
  fired?: Set<string>,
): { console?: ConsoleEntry[] } {
  if (entries === undefined) return {}
  return {
    console: entries.map((entry) => ({ ...entry, text: normalizer.text(entry.text, fired) })),
  }
}

/**
 * Reads the file Provino's `normalized-json` reporter writes and makes it comparable with
 * `convertJest` and `convertVitest` output (Track 12 T12.16). It is validated first
 * (`parseNormalizedRun`: `HARNESS_RESULT_INVALID` naming the first wrong JSON path). Then each
 * error, the file errors and run errors included, is normalized again from its `raw` text with the
 * harness's rules: the reporter keeps machine paths in `message` and has no user frame, so its own
 * fields would differ from a converted run on every failure. Console lines are normalized the same
 * way, file paths are made relative to `rootDir` where they are absolute, and `snapshotFiles`, when
 * given, become the run's snapshot files.
 * @public
 */
export function convertProvino(
  text: string,
  opts: ProvinoConvertOptions,
  source: string = 'normalized-json',
): NormalizedRun {
  const run = parseNormalizedRun(text, source)
  const normalizer = createNormalizer(
    opts.extraRoots === undefined
      ? { rootDir: opts.rootDir }
      : { rootDir: opts.rootDir, extraRoots: opts.extraRoots },
  )
  const { fired } = opts
  const relative = (file: string): string => toRelativePath(opts.rootDir, file)
  const files = run.files.map(
    (file): NormalizedFile => ({
      ...file,
      file: relative(file.file),
      ...(file.fileError === undefined
        ? {}
        : { fileError: renormalize(file.fileError, normalizer, fired) }),
      tests: file.tests.map(
        (test): NormalizedTest => ({
          ...test,
          id: { ...test.id, file: relative(test.id.file) },
          errors: test.errors.map((error) => renormalize(error, normalizer, fired)),
          ...renormalizeConsole(test.console, normalizer, fired),
        }),
      ),
      ...renormalizeConsole(file.console, normalizer, fired),
    }),
  )
  const snapshots =
    opts.snapshotFiles === undefined
      ? run.snapshots
      : {
          counters: run.snapshots?.counters ?? NO_COUNTERS,
          files: opts.snapshotFiles.toSorted(byFile),
        }
  return {
    ...run,
    ...(opts.suite === undefined ? {} : { suite: opts.suite }),
    files: files.toSorted(byFile),
    ...(snapshots === undefined ? {} : { snapshots }),
    runErrors: run.runErrors.map((error) => renormalize(error, normalizer, fired)),
  }
}
