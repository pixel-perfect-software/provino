export interface Line {
  readonly sku: string
  readonly quantity: number
  readonly unit?: number
}

export function price(quantity: number, unit = 2): number {
  if (quantity < 0) {
    throw new RangeError('negative quantity')
  }
  return quantity * unit
}

export function discount(total: number, rate?: number): number {
  const applied = rate ?? 0.1
  return total > 100 ? total * (1 - applied) : total
}

export const tax = (amount: number): number => amount * 0.2

export function total(lines: readonly Line[]): number {
  let sum = 0
  for (const line of lines) {
    sum += price(line.quantity, line.unit)
  }
  return discount(sum)
}
