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

/**
 * A problem for each package that changed a `@public` signature (`changed`: package → the reports
 * that show it) and has no changeset naming it. One changeset may name several packages, and any
 * bump level counts.
 * @internal
 */
export function missingChangesets(
  changed: ReadonlyMap<string, readonly string[]>,
  changesets: readonly Changeset[],
): readonly string[] {
  const covered = new Set(changesets.flatMap((changeset) => Object.keys(changeset.bumps)))
  return [...changed]
    .filter(([name]) => !covered.has(name))
    .map(
      ([name, reports]) =>
        `${name} changed a @public signature (${reports.join(', ')}) with no changeset: run \`pnpm changeset\` and name it`,
    )
}

/** What `.changeset/config.json` says that this repo depends on. */
interface ChangesetConfig {
  readonly ignore: readonly string[]
  /** The `fixed` groups: each lists package names released at one version (D164). */
  readonly fixed: readonly (readonly string[])[]
}

/** The strings of a JSON array, or `undefined` when the value isn't an array. */
function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : undefined
}

/**
 * The config's `ignore` list and `fixed` groups, or an error when the file is missing or isn't
 * shaped as expected.
 * @internal
 */
export function readChangesetConfig(root: string): ChangesetConfig {
  const json: unknown = JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf8'))
  const record = typeof json === 'object' && json !== null ? json : {}
  const ignore = 'ignore' in record ? strings(record.ignore) : undefined
  if (ignore === undefined) throw new Error('.changeset/config.json has no "ignore" list')
  const groups = 'fixed' in record && Array.isArray(record.fixed) ? record.fixed : undefined
  const fixed = groups?.map(strings)
  if (fixed === undefined || fixed.some((group) => group === undefined)) {
    throw new Error('.changeset/config.json has no "fixed" list of groups')
  }
  return { ignore, fixed: fixed.filter((group) => group !== undefined) }
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

/**
 * Checks `fixed` against the workspace (D164): one group, holding exactly the published
 * packages, so a release is one version and one tag. A package left out would be versioned alone
 * and stop matching the tag `release.yml` checks; a private one in the group would be versioned
 * for nothing.
 * @internal
 */
export function checkChangesetFixed(
  fixed: readonly (readonly string[])[],
  packages: readonly WorkspacePackage[],
): readonly string[] {
  const [group, ...others] = fixed
  if (group === undefined || others.length > 0) {
    return [
      `.changeset/config.json "fixed" must be one group of every published package, and has ${fixed.length} groups`,
    ]
  }
  const named = new Set(group)
  const problems: string[] = []
  const workspace = packages.filter((pkg) => pkg.rel !== '.')
  for (const pkg of workspace) {
    const name = pkg.manifest.name
    if (!pkg.manifest.private && !named.has(name)) {
      problems.push(`${name} is published but not in .changeset/config.json "fixed"`)
    }
    if (pkg.manifest.private && named.has(name)) {
      problems.push(`${name} is private but in .changeset/config.json "fixed"`)
    }
  }
  const known = new Set(workspace.map((pkg) => pkg.manifest.name))
  for (const name of named) {
    if (!known.has(name)) problems.push(`"fixed" names ${name}, which is not a workspace package`)
  }
  if (named.size !== group.length) problems.push('"fixed" names a package twice')
  return problems
}
