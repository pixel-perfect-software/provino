export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low
  if (value > high) return high
  return value
}

export function unused(): string {
  return 'not called'
}

export interface Range {
  readonly low: number
  readonly high: number
}
