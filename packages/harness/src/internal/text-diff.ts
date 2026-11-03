// A small line diff for drift reports. Lines both texts start and end with are set aside first, so
// the LCS table covers only what changed; past MAX_CELLS that falls back to comparing line by line.

interface Op {
  readonly mark: ' ' | '-' | '+'
  readonly line: string
}

const MAX_CELLS = 4_000_000
const CONTEXT = 1

/** The LCS diff of two line lists, or a position-by-position comparison past MAX_CELLS. */
function diffChanged(a: readonly string[], b: readonly string[]): Op[] {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    const ops: Op[] = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const left = a[i]
      const right = b[i]
      if (left === right && left !== undefined) ops.push({ mark: ' ', line: left })
      else {
        if (left !== undefined) ops.push({ mark: '-', line: left })
        if (right !== undefined) ops.push({ mark: '+', line: right })
      }
    }
    return ops
  }
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  const at = (i: number, j: number): number => table[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const left = a[i]
    const right = b[j]
    if (left !== undefined && left === right) {
      ops.push({ mark: ' ', line: left })
      i++
      j++
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ mark: '-', line: left })
      i++
    } else if (right !== undefined) {
      ops.push({ mark: '+', line: right })
      j++
    }
  }
  return ops
}

function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++
  }
  const same = (lines: readonly string[]): Op[] => lines.map((line) => ({ mark: ' ', line }))
  return [
    ...same(a.slice(0, start)),
    ...diffChanged(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...same(a.slice(a.length - end)),
  ]
}

/**
 * Lines that differ between two texts, `-` for `expected` and `+` for `actual`, with one line of
 * context and `...` for the unchanged stretches between changes. Empty when the texts are equal.
 */
export function lineDiff(expected: string, actual: string): string {
  if (expected === actual) return ''
  const ops = diffLines(expected.split('\n'), actual.split('\n'))
  const keep = ops.map((op, index) => {
    if (op.mark !== ' ') return true
    for (let d = 1; d <= CONTEXT; d++) {
      if (ops[index - d]?.mark !== undefined && ops[index - d]?.mark !== ' ') return true
      if (ops[index + d]?.mark !== undefined && ops[index + d]?.mark !== ' ') return true
    }
    return false
  })
  const out: string[] = []
  let skipped = false
  ops.forEach((op, index) => {
    if (keep[index]) {
      out.push(`${op.mark} ${op.line}`)
      skipped = false
    } else if (!skipped) {
      out.push('  ...')
      skipped = true
    }
  })
  return out.join('\n')
}
