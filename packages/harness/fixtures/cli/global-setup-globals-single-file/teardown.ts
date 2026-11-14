module.exports = async function globalTeardown(): Promise<void> {
  const fs = process.getBuiltinModule('node:fs')
  const seen = (globalThis as Record<string, unknown>).fromGlobalSetup
  fs.appendFileSync('seen.txt', `teardown sees: ${String(seen)}\n`)
}
