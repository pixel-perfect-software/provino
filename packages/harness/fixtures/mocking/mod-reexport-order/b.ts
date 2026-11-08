const g = globalThis as { loads?: string[] }
g.loads ??= []
g.loads.push('b')

export const bValue = 'real-b'
