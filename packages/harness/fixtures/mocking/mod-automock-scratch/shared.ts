const g = globalThis as { __counts?: Record<string, number> }
g.__counts ??= {}
g.__counts.shared = (g.__counts.shared ?? 0) + 1

module.exports = { tag: 'shared' }
