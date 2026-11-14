export type Currency = 'EUR' | 'USD' | 'GBP' | 'JPY'

export function symbol(currency: Currency): string {
  switch (currency) {
    case 'EUR':
      return '€'
    case 'USD':
      return '$'
    case 'GBP':
      return '£'
    default:
      return currency
  }
}

export function money(amount: number, currency: Currency = 'EUR'): string {
  const digits = currency === 'JPY' ? 0 : 2
  return `${symbol(currency)}${amount.toFixed(digits)}`
}

export function firstNegative(rows: readonly (readonly number[])[]): [number, number] | null {
  let found: [number, number] | null = null
  outer: for (let row = 0; row < rows.length; row++) {
    const cells = rows[row] ?? []
    for (let column = 0; column < cells.length; column++) {
      if ((cells[column] ?? 0) < 0) {
        found = [row, column]
        break outer
      }
    }
  }
  return found
}

export function label(value: number | null | undefined): string {
  return value === null ? 'none' : value === undefined ? 'unset' : value > 0 ? 'positive' : 'other'
}
