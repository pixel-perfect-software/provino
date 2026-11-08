const g = globalThis as { __counts?: Record<string, number> }
g.__counts ??= {}
g.__counts.counted = (g.__counts.counted ?? 0) + 1

const shared = require('./shared.ts') as { tag: string }

module.exports = {
  tag: shared.tag,
  hello(): string {
    return 'real hello'
  },
}
