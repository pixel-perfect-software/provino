// Number and time text the footer shares. Plain functions, no `Intl`: they run in a frame.

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

/** A clock: `0.8s`, `12.4s`, `1m 05s`, `1h 02m`. Tenths of a second below a minute. */
export function clock(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100))
  if (tenths < 600) return `${Math.floor(tenths / 10)}.${tenths % 10}s`
  const seconds = Math.floor(tenths / 10)
  if (seconds < 3600) {
    const rest = seconds % 60
    return `${Math.floor(seconds / 60)}m ${rest < 10 ? '0' : ''}${rest}s`
  }
  const minutes = Math.floor(seconds / 60) % 60
  return `${Math.floor(seconds / 3600)}h ${minutes < 10 ? '0' : ''}${minutes}m`
}

/** A rough time left: `8s`, `2m`, `1h`. Never more precise than it is. */
export function roughDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}
