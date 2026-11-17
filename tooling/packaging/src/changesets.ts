import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newFilesSince } from './git.ts'
import { record } from './package-json.ts'
import { isPublished, type WorkspacePackage } from './workspace.ts'

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

/** A list of names: an array whose every entry is a string; any other entry makes it no list. */
function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((name) => typeof name === 'string')
}

/**
 * The config's `ignore` list and `fixed` groups, or an error when the file is missing or isn't
 * shaped as expected.
 * @internal
 */
export function readChangesetConfig(root: string): ChangesetConfig {
  const { ignore, fixed } = record(
    JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf8')),
  )
  if (!isStrings(ignore)) throw new Error('.changeset/config.json has no "ignore" list')
  if (!Array.isArray(fixed) || !fixed.every(isStrings)) {
    throw new Error('.changeset/config.json has no "fixed" list of groups')
  }
  return { ignore, fixed }
}

/**
 * Checks one list of package names in `.changeset/config.json` against the workspace: `side` says
 * which packages it must hold, and it must hold exactly those. A name that is no workspace
 * package (the root isn't one) is a problem too.
 */
function checkNameList(
  listName: 'ignore' | 'fixed',
  listed: readonly string[],
  packages: readonly WorkspacePackage[],
  side: 'private' | 'published',
): readonly string[] {
  const named = new Set(listed)
  const workspace = packages.filter((pkg) => pkg.rel !== '.')
  const problems: string[] = []
  for (const pkg of workspace) {
    const name = pkg.manifest.name
    const kind = isPublished(pkg) ? 'published' : 'private'
    const isListed = named.has(name)
    if (kind === side && !isListed) {
      problems.push(`${name} is ${kind} but not in .changeset/config.json "${listName}"`)
    }
    if (kind !== side && isListed) {
      problems.push(`${name} is ${kind} but in .changeset/config.json "${listName}"`)
    }
  }
  const known = new Set(workspace.map((pkg) => pkg.manifest.name))
  for (const name of named) {
    if (!known.has(name))
      problems.push(`"${listName}" names ${name}, which is not a workspace package`)
  }
  return problems
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
  return checkNameList('ignore', ignore, packages, 'private')
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
  const problems = [...checkNameList('fixed', group, packages, 'published')]
  if (new Set(group).size !== group.length) problems.push('"fixed" names a package twice')
  return problems
}
