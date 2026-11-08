import { createRequire, stripTypeScriptTypes } from 'node:module'
import { createTransformer } from 'babel-jest'

// `@jest/transform` isn't a dependency of this package, so its types are reached through
// `babel-jest`'s own signature instead of being imported by name.
type BabelTransformer = Awaited<ReturnType<typeof createTransformer>>

const TYPESCRIPT_FILE = /\.[cm]?ts$/

/** Erases types and keeps every position (line, column), so locations stay true. */
function strip(source: string, path: string): string {
  return TYPESCRIPT_FILE.test(path) ? stripTypeScriptTypes(source, { mode: 'strip' }) : source
}

/**
 * A transform failure as a golden can hold it: Jest prints the thrown error's stack under its
 * message, and that stack names this machine's `node_modules` and this file. So the error keeps
 * its name and message and loses the frames. `babel-plugin-jest-hoist` also lists the globals a
 * factory may use ("Allowed objects: ..."), a list that follows the Node version, so that one line
 * is dropped.
 */
function tidy(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  error.message = error.message.replace(/^Allowed objects: .*\n/m, '')
  error.stack = `${error.name}: ${error.message}`
  return error
}

/** Whether the transformer config a fixture's `jestEsm` passes through `transform: [path, config]`. */
function wantsEsm(config: unknown): boolean {
  return (
    typeof config === 'object' && config !== null && 'jestEsm' in config && config.jestEsm === true
  )
}

// Resolved from this file, so it is found from a work directory under `.record/` too.
const MODULES_COMMONJS = createRequire(import.meta.url).resolve(
  '@babel/plugin-transform-modules-commonjs',
)

async function create(config?: unknown): Promise<BabelTransformer> {
  // Without `jestEsm`, `babel-jest` is created exactly as before, so every golden stays the same.
  const babel = await (wantsEsm(config)
    ? createTransformer({ plugins: [MODULES_COMMONJS] })
    : createTransformer())
  const { getCacheKey, getCacheKeyAsync, processAsync } = babel
  return {
    ...babel,
    process: (source, path, options) => {
      try {
        return babel.process(strip(source, path), path, options)
      } catch (error) {
        throw tidy(error)
      }
    },
    ...(getCacheKey && {
      getCacheKey: (source, path, options) => getCacheKey(strip(source, path), path, options),
    }),
    ...(getCacheKeyAsync && {
      getCacheKeyAsync: (source, path, options) =>
        getCacheKeyAsync(strip(source, path), path, options),
    }),
    ...(processAsync && {
      processAsync: async (source, path, options) => {
        try {
          return await processAsync(strip(source, path), path, options)
        } catch (error) {
          throw tidy(error)
        }
      },
    }),
  }
}

/**
 * The Jest transformer the recorder gives TypeScript fixtures: Node's `module.stripTypeScriptTypes`
 * first, then `babel-jest`, which is Jest's default transform, so `jest.mock` calls are hoisted as
 * in a real project. Jest loads it as a factory (`createTransformer`), so it can be async.
 * @internal
 */
const transformer: {
  readonly createTransformer: (config?: unknown) => Promise<BabelTransformer>
} = {
  createTransformer: create,
}

export default transformer
