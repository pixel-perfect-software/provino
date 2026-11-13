// Jest's global teardown: runs once, after the last test file.
module.exports = async function globalTeardown(): Promise<void> {
  const fs = process.getBuiltinModule('node:fs')
  await Promise.resolve()
  fs.appendFileSync('order.txt', 'teardown\n')
}
