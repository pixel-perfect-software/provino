const g = globalThis as { loads?: string[] }
g.loads ??= []
g.loads.push('a')

export const aValue = 'real-a'
