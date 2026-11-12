import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PackageManifest, readManifest } from './package-json.ts'

/** The repository root: two levels above `tooling/packaging/src`. */
export const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** A workspace package: where it is and what its package.json says. */
export interface WorkspacePackage {
  /** Absolute directory. */
  readonly dir: string
  /** Repo-relative directory with `/`: `packages/core`. */
  readonly rel: string
  readonly manifest: PackageManifest
}

/**
 * Every package under `packages/` and `tooling/` (the roots of `pnpm-workspace.yaml`), sorted by
 * directory, and the root package.json as `.`.
 * @internal
 */
export function readWorkspacePackages(root: string = ROOT): readonly WorkspacePackage[] {
  const found: WorkspacePackage[] = [{ dir: root, rel: '.', manifest: readManifest(root) }]
  for (const base of ['packages', 'tooling']) {
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, base, entry.name)
      try {
        found.push({ dir, rel: `${base}/${entry.name}`, manifest: readManifest(dir) })
      } catch {
        // A directory with no package.json (a scratch directory) isn't a package.
      }
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * The packages that are published: not `private`, and not the root.
 * @internal
 */
export function publicPackages(root: string = ROOT): readonly WorkspacePackage[] {
  return readWorkspacePackages(root).filter((pkg) => pkg.rel !== '.' && !pkg.manifest.private)
}

/**
 * The packages D67 promises semver for before 1.0: `provino`, the dialects, the environments and
 * `@provino/types`. Their API reports are committed and a change to a `@public` signature needs a
 * changeset. Every other published package is `@beta` as a whole: its `@public` tags say a symbol
 * is exported on purpose, and promise nothing, so it has no report.
 * @internal
 */
export const SEMVER_PACKAGES: readonly string[] = [
  'provino',
  '@provino/dialect-jest',
  '@provino/dialect-vitest',
  '@provino/env-jsdom',
  '@provino/env-node',
  '@provino/types',
]
