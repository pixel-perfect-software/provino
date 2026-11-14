export type Currency = 'EUR' | 'GBP'

export interface Price {
  readonly amount: number
  readonly currency: Currency
}
