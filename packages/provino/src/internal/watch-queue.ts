// What a native watch session runs next (B27k): the queue behind the keys and the changes, and the
// set of files that failed. Pure: no clock, no terminal, no session, so the precedence is tested
// on its own (`watch-queue.test.ts`).

/**
 * One run the session is asked for.
 * @internal
 */
export type Trigger =
  | { readonly kind: 'all' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'changed'; readonly paths: readonly string[] }

/**
 * A file's result, as far as the queue cares: its absolute path and how it ended.
 * @internal
 */
export interface FileOutcome {
  readonly path: string
  readonly state: 'pass' | 'fail' | 'skip'
}

/**
 * What waits to run, and what failed.
 * @internal
 */
export interface WatchQueue {
  /** Every file (`a`, `--watchAll`, the first run, a reloaded config). */
  all(): void
  /** The files that failed (`f`). */
  failed(): void
  /** The last run again (Enter). */
  rerun(): void
  /** These absolute paths changed: the files they reach, as one run however many batches come before it starts. */
  changed(paths: Iterable<string>): void
  /**
   * The next run, or `undefined` when nothing waits. Precedence: all, failed, changed, rerun. All
   * covers everything else that waits; a queued rerun is dropped when what runs is the run it
   * asked for.
   */
  take(): Trigger | undefined
  /** The absolute paths of the files that failed, kept up to date by `record` and `forget`. */
  readonly failedFiles: ReadonlySet<string>
  /** A run of `trigger` ended with these results: a run of all starts the failed set over, a partial one updates it. */
  record(trigger: Trigger, files: readonly FileOutcome[]): void
  /** These paths no longer exist (a rename, a delete): they are not failed files any more. */
  forget(paths: Iterable<string>): void
}

function same(a: Trigger, b: Trigger): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind !== 'changed' || b.kind !== 'changed') return true
  return (
    a.paths.length === b.paths.length && a.paths.every((path, index) => path === b.paths[index])
  )
}

/**
 * A queue that starts with a run of every file waiting.
 * @internal
 */
export function createWatchQueue(): WatchQueue {
  const failedFiles = new Set<string>()
  const changed = new Set<string>()
  let last: Trigger = { kind: 'all' }
  let wantAll = true
  let wantFailed = false
  let wantRerun = false
  return {
    all: () => {
      wantAll = true
    },
    failed: () => {
      wantFailed = true
    },
    rerun: () => {
      wantRerun = true
    },
    changed(paths) {
      for (const path of paths) changed.add(path)
    },
    take() {
      let next: Trigger
      if (wantAll) {
        wantAll = false
        wantFailed = false
        wantRerun = false
        changed.clear()
        next = { kind: 'all' }
      } else if (wantFailed) {
        wantFailed = false
        next = { kind: 'failed' }
      } else if (changed.size > 0) {
        next = { kind: 'changed', paths: [...changed].sort() }
        changed.clear()
      } else if (wantRerun) {
        wantRerun = false
        return last
      } else {
        return undefined
      }
      // An Enter that waited for this very run is answered by it.
      if (wantRerun && same(next, last)) wantRerun = false
      last = next
      return next
    },
    failedFiles,
    record(trigger, files) {
      if (trigger.kind === 'all') failedFiles.clear()
      for (const file of files) {
        if (file.state === 'fail') failedFiles.add(file.path)
        else failedFiles.delete(file.path)
      }
    },
    forget(paths) {
      for (const path of paths) failedFiles.delete(path)
    },
  }
}
