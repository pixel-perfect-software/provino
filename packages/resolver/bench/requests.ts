// What `resolve-corpus.ts` asks Node and Provino to resolve, and how Node's answers are read.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

/** Node's answer to one request: a path (or `node:` id), or the error code it threw. */
export interface NodeAnswer {
  readonly request: string
  readonly path: string | null
  readonly error: string | null
}

/** The package names pnpm links into the store, scoped ones as `@scope/name`, sorted. */
function storeNames(store: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(store).sort()) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(join(store, entry)).sort()) names.push(`${entry}/${sub}`)
    } else names.push(entry)
  }
  return names
}

/**
 * Whether a store entry is one of this workspace's own packages: pnpm links them into the store
 * beside the installed ones, but their directory is under `packages/` or `tooling/`, not under a
 * `node_modules`.
 */
function isWorkspacePackage(store: string, name: string): boolean {
  return !`${sep}${realpathSync(join(store, name))}${sep}`.includes(`${sep}node_modules${sep}`)
}

/**
 * Every installed package's bare name plus each of its literal `exports` subpaths, from pnpm's
 * hoisted store, and the names of the workspace's own packages that were left out. Those are not
 * third-party resolution cases: their `exports` name `provino-source` first and a `dist/` file
 * last, so what Node answers depends on whether a build ran, and the agreement count would too.
 */
export function collectRequests(store: string): {
  readonly requests: string[]
  readonly workspace: string[]
} {
  const requests: string[] = []
  const workspace: string[] = []
  for (const name of storeNames(store)) {
    const manifest = join(store, name, 'package.json')
    if (!existsSync(manifest)) continue
    if (isWorkspacePackage(store, name)) {
      workspace.push(name)
      continue
    }
    requests.push(name)
    const pkg: { readonly exports?: unknown } = JSON.parse(readFileSync(manifest, 'utf8'))
    const exports = pkg.exports
    if (exports === null || typeof exports !== 'object' || Array.isArray(exports)) continue
    for (const key of Object.keys(exports)) {
      if (key.startsWith('./') && !key.includes('*')) requests.push(`${name}/${key.slice(2)}`)
    }
  }
  return { requests, workspace }
}

/**
 * Node's answers with a file that isn't there read as the error `import` throws. Node's
 * `import.meta.resolve` returns the URL an `exports` target names without looking for the file
 * (a real `import()` of it throws `ERR_MODULE_NOT_FOUND`), while a resolver that checks for the
 * file answers "not found". The two agree on the thing that matters, that nothing can be loaded,
 * so such a request is not an answer to compare. `exists` is `existsSync`, injectable for tests.
 */
export function withoutMissingTargets(
  answers: readonly NodeAnswer[],
  exists: (path: string) => boolean = existsSync,
): NodeAnswer[] {
  return answers.map((answer) => {
    if (answer.path === null || answer.path.startsWith('node:') || exists(answer.path)) {
      return answer
    }
    return { request: answer.request, path: null, error: 'ERR_MODULE_NOT_FOUND' }
  })
}
