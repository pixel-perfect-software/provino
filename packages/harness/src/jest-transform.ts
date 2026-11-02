import { stripTypeScriptTypes } from 'node:module'
import { createTransformer } from 'babel-jest'

// `@jest/transform` isn't a dependency of this package, so its types are reached through
// `babel-jest`'s own signature instead of being imported by name.
type BabelTransformer = Awaited<ReturnType<typeof createTransformer>>

const TYPESCRIPT_FILE = /\.[cm]?ts$/

/** Erases types and keeps every position (line, column), so locations stay true. */
function strip(source: string, path: string): string {
  return TYPESCRIPT_FILE.test(path) ? stripTypeScriptTypes(source, { mode: 'strip' }) : source
}

async function create(): Promise<BabelTransformer> {
  const babel = await createTransformer()
  const { getCacheKey, getCacheKeyAsync, processAsync } = babel
  return {
    ...babel,
    process: (source, path, options) => babel.process(strip(source, path), path, options),
    ...(getCacheKey && {
      getCacheKey: (source, path, options) => getCacheKey(strip(source, path), path, options),
    }),
    ...(getCacheKeyAsync && {
      getCacheKeyAsync: (source, path, options) =>
        getCacheKeyAsync(strip(source, path), path, options),
    }),
    ...(processAsync && {
      processAsync: (source, path, options) => processAsync(strip(source, path), path, options),
    }),
  }
}

/**
 * The Jest transformer the recorder gives TypeScript fixtures: Node's `module.stripTypeScriptTypes`
 * first, then `babel-jest`, which is Jest's default transform, so `jest.mock` calls are hoisted as
 * in a real project. Jest loads it as a factory (`createTransformer`), so it can be async.
 * @public
 */
const transformer: { readonly createTransformer: () => Promise<BabelTransformer> } = {
  createTransformer: create,
}

export default transformer
