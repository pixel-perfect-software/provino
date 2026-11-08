// Jest's global setup: records its arguments.
module.exports = async function globalSetup(...args: unknown[]): Promise<void> {
  const fs = process.getBuiltinModule('node:fs')
  const [first, second] = args as [Record<string, unknown>?, Record<string, unknown>?]
  const shown = {
    arguments: args.length,
    firstHasRootDir: typeof first?.rootDir === 'string',
    secondHasTestMatch: Array.isArray(second?.testMatch),
  }
  fs.writeFileSync('global-setup.txt', `${JSON.stringify(shown)}\n`)
}
