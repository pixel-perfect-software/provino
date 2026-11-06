const g = globalThis as { realLoads?: number }
g.realLoads = (g.realLoads ?? 0) + 1

export const kind = 'real'
