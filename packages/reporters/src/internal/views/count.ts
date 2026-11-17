// The count text the views share: digits grouped, and a count with its noun. Plain functions, no
// `Intl`: they run in a frame. They live here, not under `live/`, so the folder helpers (shared with
// the HTML report) can use them: `internal/` never imports `live/`.

/** `1204` as `1,204`. */
export function groupDigits(value: number): string {
  const text = String(Math.trunc(value))
  if (text.length <= 3) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && (text.length - i) % 3 === 0) out += ','
    out += text[i]
  }
  return out
}

/** `1 test`, `3 tests`, `1,204 files`: the count with its digits grouped, then the noun. */
export function plural(count: number, noun: string): string {
  return `${groupDigits(count)} ${noun}${count === 1 ? '' : 's'}`
}
