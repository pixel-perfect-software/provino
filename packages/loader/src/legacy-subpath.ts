// A shared external loads natively (an `import()` of its file, or a `require`), so its own imports
// are resolved by Node, not by the loader's resolver. Node's ES module resolution adds no extension
// and no index file, so a bare import of a subpath into a package with no `exports` map fails with
// ERR_MODULE_NOT_FOUND ("Did you mean to import "next/server.js"?"): next-intl's ES module build
// imports `next/server`, and `next` has no `exports`. A bundler, tsx and jest-resolve all find
// `next/server.js`. The worker installs one synchronous resolve hook for its lifetime: Node's own
// resolution runs first, and only when it throws ERR_MODULE_NOT_FOUND or ERR_UNSUPPORTED_DIR_IMPORT
// for such a specifier, imported from a file under `node_modules`, is the subpath resolved as
// `require` resolves it, which is the file Node's own error names. A package with an `exports` map
// keeps Node's error, as does every relative or absolute specifier.
import { readFileSync, statSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The codes Node's ES module resolution throws for a file it does not complete. */
const RETRIED: ReadonlySet<string> = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'])

/** A URL scheme (`node:`, `file:`, `data:`), or a Windows drive letter. */
const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/

/** A bare specifier's package name and the subpath after it, or `undefined` when it has none. */
function packageSubpath(
  specifier: string,
): { readonly name: string; readonly subpath: string } | undefined {
  const first = specifier[0]
  if (first === '.' || first === '/' || first === '#' || SCHEME.test(specifier)) return undefined
  const parts = specifier.split('/')
  const size = first === '@' ? 2 : 1
  const subpath = parts.slice(size).join('/')
  return subpath === '' ? undefined : { name: parts.slice(0, size).join('/'), subpath }
}

/** The directory Node's lookup takes the package `name` from: `node_modules/<name>`, walking up from `from`. */
function packageDirectory(name: string, from: string): string | undefined {
  let dir = dirname(from)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Whether the package at `dir` has no `exports` map (a missing `package.json` has none). */
function hasNoExports(dir: string): boolean {
  let text: string
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch {
    return true
  }
  try {
    const manifest: unknown = JSON.parse(text)
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      (manifest as { readonly exports?: unknown }).exports == null
    )
  } catch {
    return false
  }
}

/**
 * The URL a bare `specifier` imported from `parentURL` resolves to as `require` resolves it, when
 * Node's ES module resolution threw `error` for it only because it adds no extension or index file:
 * the code is ERR_MODULE_NOT_FOUND or ERR_UNSUPPORTED_DIR_IMPORT, the importer is a file under
 * `node_modules`, and the specifier names a subpath of a package with no `exports` map. Otherwise
 * `undefined`, and Node's error stands.
 * @internal
 */
export function legacySubpathTarget(
  specifier: string,
  parentURL: string | undefined,
  error: unknown,
): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  if (typeof code !== 'string' || !RETRIED.has(code)) return undefined
  if (parentURL?.startsWith('file:') !== true) return undefined
  const bare = packageSubpath(specifier)
  if (bare === undefined) return undefined
  const parent = fileURLToPath(parentURL)
  if (!parent.split(sep).includes('node_modules')) return undefined
  const dir = packageDirectory(bare.name, parent)
  if (dir === undefined || !hasNoExports(dir)) return undefined
  try {
    return pathToFileURL(createRequire(join(dir, 'package.json')).resolve(`./${bare.subpath}`)).href
  } catch {
    return undefined
  }
}

/**
 * Installs, for this thread, the worker's fallback for a module Node loads itself (a shared
 * external): a bare import of a subpath into a package with no `exports` map resolves as `require`
 * would (`legacySubpathTarget`), where Node's ES module resolution adds no extension or index file.
 * One synchronous `module.registerHooks` resolve hook, which every resolution Node makes in the
 * thread goes through: a lookup that succeeds costs the hook's call (about 3 µs more per native
 * `require`, nothing measurable per `import`: `local`, Node 24). Returns the call that removes it.
 * @public
 */
export function installLegacySubpathFallback(): () => void {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        const url = legacySubpathTarget(specifier, context.parentURL, error)
        if (url === undefined) throw error
        return { url, shortCircuit: true }
      }
    },
  })
  return () => hooks.deregister()
}
