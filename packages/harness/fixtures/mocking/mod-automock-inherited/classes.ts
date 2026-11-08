export class A {
  static aStatic(): string {
    return 'real-a-static'
  }

  aMethod(): string {
    return 'real-a-method'
  }

  shared(): string {
    return 'real-a-shared'
  }
}

export class B extends A {
  static bStatic(): string {
    return 'real-b-static'
  }

  bMethod(): string {
    return 'real-b-method'
  }

  shared(): string {
    return 'real-b-shared'
  }
}

const base = {
  inherited(): string {
    return 'real-inherited'
  },
  inheritedValue: 7,
}
export const child: { own: () => string; inherited: () => string; inheritedValue: number } =
  Object.assign(Object.create(base), { own: (): string => 'real-own' })
