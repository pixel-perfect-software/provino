// A module with every shape automock has to decide about.
export function fn(a: number): string {
  return `real fn ${a}`
}

export class Klass {
  field = 'set by the constructor'
  constructor() {
    this.field = 'constructor ran'
  }
  method(): string {
    return 'real method'
  }
  get accessor(): string {
    return 'real accessor'
  }
  static make(): string {
    return 'real static'
  }
  static staticValue = 'static value'
}

export class Sub extends Klass {
  extra(): string {
    return 'real extra'
  }
}

export const nested = {
  deep: {
    call(): string {
      return 'real deep call'
    },
    value: 7,
  },
  get computed(): string {
    return 'real getter'
  },
  label: 'nested label',
}

export const list = [1, 2, 3]
export const map = new Map([['k', 'v']])
export const text = 'a string'
export const count = 42
export const flag = true
export const nothing = null
export const pattern = /abc/g
export const when = new Date(0)
export const big = 10n
