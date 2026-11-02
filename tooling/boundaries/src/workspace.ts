import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { allowedDeps, type Manifest, type ManifestNode, type Problem } from './manifest.ts'

/**
 * A workspace package as its package.json declares it.
 * @public
 */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/core`. */
  readonly dir: string
  readonly name: string
  /** Every package it depends on, of any dependency kind. */
  readonly deps: readonly string[]
}

/** The workspace globs in pnpm-workspace.yaml, as directories. */
export const WORKSPACE_DIRS: readonly string[] = ['packages', 'tooling']

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Reads every workspace package under `root`, sorted by directory.
 * @public
 */
export async function readWorkspace(root: string): Promise<readonly WorkspacePackage[]> {
  const out: WorkspacePackage[] = []
  for (const base of WORKSPACE_DIRS) {
    const entries = await readdir(join(root, base), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = `${base}/${entry.name}`
      const json: unknown = await readFile(join(root, dir, 'package.json'), 'utf8').then(
        (text) => JSON.parse(text),
        () => undefined,
      )
      if (json === undefined || json === null || typeof json !== 'object') continue
      const manifest = json as Readonly<Record<string, unknown>>
      const deps = DEP_FIELDS.flatMap((field) => {
        const value = manifest[field]
        return value !== null && typeof value === 'object' ? Object.keys(value) : []
      })
      out.push({ dir, name: String(manifest.name), deps: [...new Set(deps)].sort() })
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Whether a manifest name or dir pattern (with `*`) matches a value.
 * @public
 */
export function matches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value
  const re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('[^/]+')}$`)
  return re.test(value)
}

/**
 * Checks the workspace against the manifest: every package is listed under its own name, and its
 * package.json depends only on packages the manifest allows.
 * @public
 */
export function checkWorkspace(
  manifest: Manifest,
  packages: readonly WorkspacePackage[],
): readonly Problem[] {
  const problems: Problem[] = []
  const tops = manifest.nodes.filter((node) => node.parent === undefined)
  const packageOf = (name: string): ManifestNode | undefined =>
    tops.find((node) => matches(node.name, name))

  for (const pkg of packages) {
    const node = tops.find((candidate) => candidate.dir !== null && matches(candidate.dir, pkg.dir))
    if (node === undefined) {
      problems.push({
        rule: 'manifest-unknown-package',
        message: `${pkg.dir} (${pkg.name}) is not in tooling/boundaries/packages.json`,
      })
      continue
    }
    if (!matches(node.name, pkg.name)) {
      problems.push({
        rule: 'manifest-name',
        message: `${pkg.dir} is named "${pkg.name}", but the manifest lists it as "${node.name}"`,
      })
    }
    // A package may depend on what any of its entries may import, at package granularity.
    const entries = manifest.nodes.filter((n) => n === node || n.parent === node.name)
    const allowed = new Set(
      entries.flatMap((entry) =>
        allowedDeps(manifest, entry).map((dep) => packageOf(dep.name)?.name ?? dep.name),
      ),
    )
    for (const dep of pkg.deps) {
      const target = packageOf(dep)
      if (target === undefined || target === node || allowed.has(target.name)) continue
      problems.push({
        rule: 'manifest-deps',
        message: `${pkg.name} depends on ${dep} in package.json, but the manifest doesn't allow it`,
      })
    }
  }
  return problems
}

/**
 * Escapes RegExp syntax in a literal path or name.
 * @public
 */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}
