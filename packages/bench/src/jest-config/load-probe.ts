// One cold load of a Jest config, in its own process (`pnpm bench:jest-config load` spawns it): the
// import of the reader, `findJestConfig` and `loadJestConfig`, timed from before the import, so
// the in-process number includes loading Provino's own modules. Prints one `PROVINO_SAMPLE` line.
//
// Usage: node --conditions=provino-source load-probe.ts <dir>
import { performance } from 'node:perf_hooks'

const dir = process.argv[2]
if (dir === undefined) throw new Error('usage: load-probe.ts <dir>')
const start = performance.now()
const { findJestConfig, loadJestConfig } = await import('@provino/dialect-jest/node')
const imported = performance.now()
const loaded = await loadJestConfig(findJestConfig(dir))
const end = performance.now()
process.stdout.write(
  `PROVINO_SAMPLE ${JSON.stringify({
    inProcessMs: end - start,
    loadMs: end - imported,
    keys: Object.keys(loaded.options).filter((key) => key !== 'rootDir').length,
  })}\n`,
)
