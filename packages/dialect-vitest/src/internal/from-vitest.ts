// For tests and their oracles: a package of Vitest's own install (`@vitest/expect`, `@vitest/utils`),
// reached from `vitest`, a devDependency, so nothing is added.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const fromVitest = createRequire(fileURLToPath(import.meta.resolve('vitest')))

/**
 * Imports `name` as Vitest's own install resolves it.
 * @internal
 */
export async function importFromVitest(name: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(fromVitest.resolve(name)).href)
}
