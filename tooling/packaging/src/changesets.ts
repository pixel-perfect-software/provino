import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newFilesSince } from './git.ts'
import type { WorkspacePackage } from './workspace.ts'

/** A changeset file: which packages it bumps, and by how much. */
export interface Changeset {
  readonly file: string
  readonly bumps: Readonly<Record<string, string>>
}

/**
 * Reads the packages a changeset names from its front matter (`"pkg": minor`, one per line).
 * Anything else in the file is the release note. A file with no front matter bumps nothing.
 * @internal
 */
export function parseChangeset(file: string, text: string): Changeset {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const bumps: Record<string, string> = {}
  for (const line of front.split(/\r?\n/)) {
    const match = /^\s*["']?([^"':]+?)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) bumps[match[1]] = match[2]
  }
  return { file, bumps }
}

/**
 * The changesets added since `base`: `.changeset/*.md` that are new there (the folder's README
 * and config aren't changesets).
 * @internal
 */
export function changesetsSince(root: string, base: string): readonly Changeset[] {
  return newFilesSince(root, base, '.changeset')
    .filter((file) => file.endsWith('.md') && !file.endsWith('README.md'))
    .map((file) => parseChangeset(file, readFileSync(join(root, file), 'utf8')))
}

/** A package whose `@public` API changed since the base, with the reports that show it. */
export interface PublicChange {
  readonly package: string
  readonly reports: readonly string[]
}

/**
 * The packages that changed a `@public` signature and have no changeset naming them. One
 * changeset may name several packages, and any bump level counts.
 * @internal
 */
export function missingChangesets(
  changes: readonly PublicChange[],
  changesets: readonly Changeset[],
): readonly string[] {
  const covered = new Set(changesets.flatMap((changeset) => Object.keys(changeset.bumps)))
  return changes.filter((change) => !covered.has(change.package)).map((change) => change.package)
}

/** What `.changeset/config.json` says that this repo depends on. */
interface ChangesetConfig {
  readonly ignore: readonly string[]
}

/**
 * The config's `ignore` list, or an error when the file is missing or isn't shaped as expected.
 * @internal
 */
export function readChangesetConfig(root: string): ChangesetConfig {
  const json: unknown = JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf8'))
  const ignore =
    typeof json === 'object' && json !== null && 'ignore' in json && Array.isArray(json.ignore)
      ? json.ignore.filter((name): name is string => typeof name === 'string')
      : undefined
  if (ignore === undefined) throw new Error('.changeset/config.json has no "ignore" list')
  return { ignore }
}

/**
 * Checks `ignore` against the workspace: every private package is skipped (they are never
 * published, so a release has nothing to version for them), and no published package is.
 * @internal
 */
export function checkChangesetIgnore(
  ignore: readonly string[],
  packages: readonly WorkspacePackage[],
): readonly string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    if (pkg.rel === '.') continue
    const ignored = ignore.includes(pkg.manifest.name)
    if (pkg.manifest.private && !ignored) {
      problems.push(`${pkg.manifest.name} is private but not in .changeset/config.json "ignore"`)
    }
    if (!pkg.manifest.private && ignored) {
      problems.push(`${pkg.manifest.name} is published but in .changeset/config.json "ignore"`)
    }
  }
  const names = new Set(packages.map((pkg) => pkg.manifest.name))
  for (const name of ignore) {
    if (!names.has(name)) problems.push(`"ignore" names ${name}, which is not a workspace package`)
  }
  return problems
}
