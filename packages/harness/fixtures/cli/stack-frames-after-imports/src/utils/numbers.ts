export type NumberKind = 'small' | 'large'

export const numberOne = 1
export const numberTwo = 2
export const numberThree = 3

export function addNumbers(a: number, b: number): number {
  return a + b
}

export function kindOfNumber(value: number): NumberKind {
  return value < 10 ? 'small' : 'large'
}
