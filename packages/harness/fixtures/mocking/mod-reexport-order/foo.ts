const g = globalThis as { loads?: string[] }
g.loads ??= []
g.loads.push('foo')

export const fooValue = 'real-foo'
