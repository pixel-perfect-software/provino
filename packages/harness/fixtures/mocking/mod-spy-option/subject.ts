export function add(a: number, b: number): number {
  return a + b
}

export const holder = {
  get computed(): string {
    return 'real getter'
  },
  twice(n: number): number {
    return n * 2
  },
  label: 'kept',
}
