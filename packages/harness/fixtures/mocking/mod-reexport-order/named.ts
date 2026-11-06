const g = globalThis as { loads?: string[] }
g.loads ??= []
g.loads.push('named')

export const namedValue = 'real-named'
