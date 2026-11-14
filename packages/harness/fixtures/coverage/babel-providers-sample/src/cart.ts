import { type Line, total } from './pricing.ts'

export class Cart {
  readonly lines: Line[] = []
  #coupon: string | undefined
  static created = 0
  owner: string

  constructor(owner?: string) {
    Cart.created += 1
    this.owner = owner ?? 'guest'
  }

  add(line: Line): this {
    const existing = this.lines.find((entry) => entry.sku === line.sku)
    if (existing) {
      this.lines[this.lines.indexOf(existing)] = {
        ...existing,
        quantity: existing.quantity + line.quantity,
      }
    } else {
      this.lines.push(line)
    }
    return this
  }

  get size(): number {
    return this.lines.length
  }

  set coupon(code: string | undefined) {
    this.#coupon ||= code
  }

  get coupon(): string | undefined {
    return this.#coupon
  }

  checkout(): number {
    const amount = total(this.lines)
    return this.#coupon?.startsWith('HALF') ? amount / 2 : amount
  }

  clear(): void {
    this.lines.length = 0
    this.#coupon &&= undefined
  }
}
