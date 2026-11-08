function describeThis(self: unknown): string {
  if (self === undefined) return 'undefined'
  if (self === globalThis) return 'global'
  if (typeof self === 'object' && self !== null && 'whoAmI' in self && 'tag' in self) {
    return typeof (self as { tag: unknown }).tag === 'string'
      ? 'default-object'
      : 'module-namespace'
  }
  return 'other'
}

export function whoAmI(this: unknown): string {
  return describeThis(this)
}

export function tag(this: unknown, _strings: TemplateStringsArray): string {
  return describeThis(this)
}

export default {
  tag: 'default-object',
  whoAmI(this: unknown): string {
    return describeThis(this)
  },
}
