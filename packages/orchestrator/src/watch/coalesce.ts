// T9.11: the watcher's events gathered into batches, as jest-haste-map's ChangeQueue does
// (ChangeQueue.ts L26, L68-73): a batch is emitted 30 ms after its first event, repeats of one
// `kind:path:mtime` are dropped within it (L108-113), and a `change` whose mtime has not moved is
// no change (an access, L96-104). The clock is injected, so the tests drive the window by hand.
import type { AffectedEvent } from '../affected/index.ts'

/**
 * One thing the watcher saw happen to an absolute path, with the file's mtime in ms when it is
 * there (`undefined` for an `unlink`).
 * @beta
 */
export interface WatchEvent extends AffectedEvent {
  readonly mtimeMs: number | undefined
}

/**
 * The timers a coalescer uses: `globalThis`'s by default, a fake one in a test.
 * @beta
 */
export interface CoalesceClock {
  /** Calls `callback` after `ms`, unless the function it returns is called first. */
  schedule(callback: () => void, ms: number): () => void
}

/**
 * Jest's window: ChangeQueue.ts L26 (`CHANGE_INTERVAL`).
 * @beta
 */
export const COALESCE_WINDOW_MS = 30

/**
 * What a coalescer is made with.
 * @beta
 */
export interface CoalesceOptions {
  /** Receives each batch, in the order its events came. Never called with an empty one. */
  readonly emit: (batch: readonly WatchEvent[]) => void
  /** How long after its first event a batch is emitted. Default `COALESCE_WINDOW_MS`. */
  readonly windowMs?: number
  readonly clock?: CoalesceClock
  /** The mtimes already known (a crawl's), so the first `change` of an untouched file is dropped. */
  readonly known?: ReadonlyMap<string, number>
}

/**
 * Gathers watch events into batches.
 * @beta
 */
export interface Coalescer {
  push(event: WatchEvent): void
  /** Emits what is waiting now, without waiting for the window to end. */
  flush(): void
  /** Drops what is waiting and stops the timer; later pushes are ignored. */
  close(): void
}

const realClock: CoalesceClock = {
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * Makes a coalescer: the first event opens a window of `windowMs`, and at its end every event it
 * gathered is emitted as one batch. Later events don't stretch the window, so a stream of saves
 * still runs every `windowMs` (Jest's `setInterval`, without a timer while nothing happens).
 * @beta
 */
export function createCoalescer(options: CoalesceOptions): Coalescer {
  const windowMs = options.windowMs ?? COALESCE_WINDOW_MS
  const clock = options.clock ?? realClock
  /** The last mtime seen of each path, from the crawl and from every event since. */
  const known = new Map(options.known)
  let pending: WatchEvent[] = []
  const keys = new Set<string>()
  let cancel: (() => void) | undefined
  let closed = false

  function flush(): void {
    cancel?.()
    cancel = undefined
    if (pending.length === 0) return
    const batch = pending
    pending = []
    keys.clear()
    options.emit(batch)
  }

  return {
    push(event) {
      if (closed) return
      // An access, not a change: the file's mtime is the one already known.
      if (
        event.kind === 'change' &&
        event.mtimeMs !== undefined &&
        known.get(event.path) === event.mtimeMs
      ) {
        return
      }
      if (event.kind === 'unlink') known.delete(event.path)
      else if (event.mtimeMs !== undefined) known.set(event.path, event.mtimeMs)
      const key = `${event.kind}:${event.path}:${event.mtimeMs ?? ''}`
      if (keys.has(key)) return
      // The file is back, so a later unlink in this window is news again. An unlink's key has no
      // mtime, so ChangeQueue.ts (L108-113) drops the second unlink of `unlink, add, unlink` and
      // ends the window with the file present; a D7 fix.
      if (event.kind !== 'unlink') keys.delete(`unlink:${event.path}:`)
      keys.add(key)
      pending.push(event)
      cancel ??= clock.schedule(flush, windowMs)
    },
    flush,
    close() {
      closed = true
      cancel?.()
      cancel = undefined
      pending = []
      keys.clear()
    },
  }
}
