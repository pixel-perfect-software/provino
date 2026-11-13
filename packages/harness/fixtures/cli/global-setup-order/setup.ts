// Jest's global setup: runs once, before the first test file.
module.exports = async function globalSetup(): Promise<void> {
  const fs = process.getBuiltinModule('node:fs')
  await Promise.resolve()
  fs.appendFileSync('order.txt', 'setup\n')
}
