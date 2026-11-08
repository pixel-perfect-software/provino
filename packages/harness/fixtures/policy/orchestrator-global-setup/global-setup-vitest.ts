// Vitest's global setup: records its arguments, and whether the teardown it returns runs.
const fs = process.getBuiltinModule('node:fs')

export default function globalSetup(...args: unknown[]): () => void {
  const [project] = args as [Record<string, unknown>?]
  const shown = { arguments: args.length, firstHasProvide: typeof project?.provide === 'function' }
  fs.writeFileSync('global-setup.txt', `${JSON.stringify(shown)}\n`)
  return () => {
    fs.appendFileSync('global-setup.txt', 'teardown ran\n')
  }
}
