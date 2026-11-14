export function fail(message: string): never {
  throw new Error(message)
}

export function checked(value: number): number {
  if (value < 0) {
    fail('negative')
    return -1
  }
  return value
}

export function greet(name = 'world', punctuation = '!'): string {
  return `hello ${name}${punctuation}`
}

/* istanbul ignore next */
export function debugOnly(): string {
  return 'never counted'
}

export function parse(input: string): number | undefined {
  const value = Number(input)
  /* istanbul ignore else */
  if (!Number.isNaN(value)) {
    return value
  } else {
    return undefined
  }
}

export function both(a: boolean, b: boolean): string {
  if (a && b) return 'both'
  if (a || b) return 'one'
  return 'none'
}

export const lazy = async (load: () => Promise<number>): Promise<number> => {
  try {
    return await load()
  } catch {
    return 0
  } finally {
    void 0
  }
}
