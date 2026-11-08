const g = globalThis as { counterLoads?: number }
g.counterLoads = (g.counterLoads ?? 0) + 1

export const loads = g.counterLoads
