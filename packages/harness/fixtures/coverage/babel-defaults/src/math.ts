export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low
  if (value > high) return high
  return value
}

export const sign = (value: number): -1 | 0 | 1 => (value < 0 ? -1 : value > 0 ? 1 : 0)
