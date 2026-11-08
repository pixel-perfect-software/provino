export * as inner from './inner.ts'

export function top(): string {
  return 'real-top'
}

export const list: unknown[] = [() => 'real-item', { f: () => 'real-f' }, 3]
