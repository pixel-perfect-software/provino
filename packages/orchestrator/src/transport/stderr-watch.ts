// What a forked child's stderr is read for after it dies: V8's last words about the heap, kept as
// a sticky flag rather than as a slice of the text.

/** What V8 prints before it aborts a process that ran out of heap. */
const HEAP_OOM = /JavaScript heap out of memory|Reached heap limit|Ineffective mark-compacts/

/** How much of the end of a chunk is carried over, so a line split across two chunks still matches. */
const CARRY_CHARS = 256

/**
 * Watches a child's stderr as it arrives.
 *
 * V8 prints its fatal error and then about 8 KB of native stack, so the line that says "heap out
 * of memory" can be older than any fixed-size tail of the stream. Each chunk is looked at (joined
 * to the end of the one before) and the answer is remembered.
 */
export interface StderrWatch {
  /** Takes the next chunk of stderr. */
  push(chunk: string): void
  /** Whether V8's heap-out-of-memory fatal error has gone by, wherever it sat in the stream. */
  readonly sawHeapOom: boolean
}

/** A fresh `StderrWatch`. */
export function createStderrWatch(): StderrWatch {
  let carry = ''
  let sawHeapOom = false
  return {
    push(chunk) {
      const joined = carry + chunk
      if (!sawHeapOom && HEAP_OOM.test(joined)) sawHeapOom = true
      carry = joined.slice(-CARRY_CHARS)
    },
    get sawHeapOom() {
      return sawHeapOom
    },
  }
}
