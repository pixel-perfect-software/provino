const fs = process.getBuiltinModule('node:fs')

test('sees what the setup set on globalThis either', () => {
  const seen = (globalThis as Record<string, unknown>).fromGlobalSetup
  fs.appendFileSync('seen.txt', `test sees: ${String(seen)}\n`)
})
