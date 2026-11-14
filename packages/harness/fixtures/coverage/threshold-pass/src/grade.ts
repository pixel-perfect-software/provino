export function grade(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 50) return 'B'
  return 'F'
}

export function unusedHelper(): number {
  return 42
}
