import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apiEntries,
  type Extraction,
  extract,
  publicApiChanged as publicChange,
  reportDifferences,
  writeReports,
} from './api-reports.ts'
import {
  changesetsSince,
  checkChangesetIgnore,
  missingChangesets,
  type PublicChange,
  readChangesetConfig,
} from './changesets.ts'
import { fileAt, resolveBase } from './git.ts'
import { installScriptProblems } from './install-scripts.ts'
import { runKnip } from './knip.ts'
import { lintPacks } from './lint-pack.ts'
import { packAll } from './pack.ts'
import { runtimeDependencyNames } from './package-json.ts'
import { lintReleaseWorkflow } from './release-lint.ts'
import {
  publicPackages,
  readWorkspacePackages,
  SEMVER_PACKAGES,
  type WorkspacePackage,
} from './workspace.ts'

/** The checks `pnpm hygiene` runs, in order. */
export const SECTIONS = [
  'install-scripts',
  'changeset-config',
  'umbrella-deps',
  'release',
  'packs',
  'api',
  'knip',
] as const

export type Section = (typeof SECTIONS)[number]

/** What one section found. Empty `problems` means it passed. */
export interface SectionResult {
  readonly section: Section
  readonly problems: readonly string[]
  /** Facts worth printing that aren't failures: counts, what was skipped. */
  readonly notes: readonly string[]
}

/** What `pnpm hygiene` takes. */
export interface HygieneOptions {
  readonly root: string
  /** The ref the branch will merge into; `@public` changes are measured against it. */
  readonly base: string
  /** Rewrite the committed API reports instead of failing on a difference. */
  readonly updateApi: boolean
  readonly only?: readonly Section[]
}

/** The workflow text of `.github/workflows/release.yml`, when B21h has added it. */
const RELEASE_WORKFLOW = '.github/workflows/release.yml'
const RELEASE_TEMPLATE = 'tooling/packaging/templates/release.yml'

/**
 * `provino` inlines every `@provino/*` package it lists as a workspace dev dependency, and the ones
 * those depend on, so the third-party packages they need at run time must be `provino`'s own dependencies: a package
 * missing there installs, then fails to import. The reverse also fails: a dependency nothing
 * inlined needs is dead weight on every install.
 * @internal
 */
export function umbrellaDependencyProblems(
  packages: readonly WorkspacePackage[],
): readonly string[] {
  const umbrella = packages.find((pkg) => pkg.manifest.name === 'provino')
  if (umbrella === undefined) return ['the `provino` package is missing']
  // The closure: what provino lists as a workspace package, and what those packages depend on.
  const inlined = new Set<string>()
  const queue = Object.keys(umbrella.manifest.devDependencies).filter((name) =>
    name.startsWith('@provino/'),
  )
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (inlined.has(name)) continue
    inlined.add(name)
    const pkg = packages.find((candidate) => candidate.manifest.name === name)
    for (const dependency of pkg === undefined ? [] : runtimeDependencyNames(pkg.manifest)) {
      if (dependency.startsWith('@provino/')) queue.push(dependency)
    }
  }
  const needed = new Set<string>()
  for (const name of inlined) {
    const pkg = packages.find((candidate) => candidate.manifest.name === name)
    for (const dependency of pkg === undefined ? [] : runtimeDependencyNames(pkg.manifest)) {
      if (!dependency.startsWith('@provino/')) needed.add(dependency)
    }
  }
  const declared = new Set(runtimeDependencyNames(umbrella.manifest))
  return [
    ...[...needed]
      .filter((name) => !declared.has(name))
      .map((name) => `provino inlines packages that need ${name}, but does not list it`),
    ...[...declared]
      .filter((name) => !needed.has(name))
      .map((name) => `provino lists ${name}, but no package it inlines needs it`),
  ]
}

function runSection(section: Section, options: HygieneOptions, workDir: string): SectionResult {
  const { root } = options
  const problems: string[] = []
  const notes: string[] = []
  const packages = readWorkspacePackages(root)
  switch (section) {
    case 'install-scripts': {
      problems.push(...installScriptProblems(packages))
      notes.push(`${packages.length} package.json files checked`)
      break
    }
    case 'changeset-config': {
      problems.push(...checkChangesetIgnore(readChangesetConfig(root).ignore, packages))
      break
    }
    case 'umbrella-deps': {
      problems.push(...umbrellaDependencyProblems(packages))
      break
    }
    case 'release': {
      const template = readFileSync(join(root, RELEASE_TEMPLATE), 'utf8')
      for (const problem of lintReleaseWorkflow(template, { draft: true })) {
        problems.push(`${RELEASE_TEMPLATE}: ${problem}`)
      }
      if (existsSync(join(root, RELEASE_WORKFLOW))) {
        const text = readFileSync(join(root, RELEASE_WORKFLOW), 'utf8')
        for (const problem of lintReleaseWorkflow(text, { draft: /\bDRAFT\b/.test(text) })) {
          problems.push(`${RELEASE_WORKFLOW}: ${problem}`)
        }
      } else {
        notes.push(`${RELEASE_WORKFLOW} does not exist yet (B21h adds it from the template)`)
      }
      break
    }
    case 'packs': {
      const packs = packAll(publicPackages(root), join(workDir, 'packs'))
      for (const problem of lintPacks(packs, root)) {
        problems.push(`${problem.tool} failed on ${problem.name}:\n${problem.output.trim()}`)
      }
      notes.push(`${packs.length} packs checked with publint and attw (--profile esm-only)`)
      break
    }
    case 'api': {
      const extractions = apiEntries(packages).map((entry) => extract(entry, join(workDir, 'api')))
      for (const { entry, errors } of extractions) {
        for (const error of errors)
          problems.push(`${entry.pkg.manifest.name} (${entry.name}): ${error}`)
      }
      const usable = extractions.filter((extraction) => extraction.errors.length === 0)
      const differences = reportDifferences(usable)
      if (options.updateApi) {
        writeReports(differences)
        notes.push(`${differences.length} API reports rewritten`)
      } else {
        for (const { entry } of differences) {
          problems.push(
            `${entry.pkg.rel}/${entry.report} is out of date: run \`pnpm hygiene:update-api\` and commit it`,
          )
        }
      }
      problems.push(...changesetProblems(options, usable))
      notes.push(`${extractions.length} API reports for ${SEMVER_PACKAGES.length} packages`)
      break
    }
    case 'knip': {
      const result = runKnip(root)
      if (!result.ok) problems.push(`knip found problems:\n${result.output.trim()}`)
      break
    }
  }
  return { section, problems, notes }
}

/**
 * A `@public` signature changed since the base, with no changeset added since it naming the
 * package. The changed signature is the difference between the report at `base` and the one the
 * extraction produced now (what `--update-api` would commit).
 */
function changesetProblems(
  options: HygieneOptions,
  extractions: readonly Extraction[],
): readonly string[] {
  const base = resolveBase(options.root, options.base)
  const changed = new Map<string, string[]>()
  for (const { entry, report } of extractions) {
    const before = fileAt(options.root, base, `${entry.pkg.rel}/${entry.report}`)
    // What will be committed: the report just generated under --update-api, else the one on disk
    // (a stale one is its own problem above).
    const now = options.updateApi ? report : readCommitted(options.root, entry)
    if (publicChange(before, now)) {
      changed.set(entry.pkg.manifest.name, [
        ...(changed.get(entry.pkg.manifest.name) ?? []),
        entry.report,
      ])
    }
  }
  const changes: PublicChange[] = [...changed].map(([name, reports]) => ({
    package: name,
    reports,
  }))
  return missingChangesets(changes, changesetsSince(options.root, base)).map((name) => {
    const reports = changed.get(name)?.join(', ') ?? ''
    return `${name} changed a @public signature (${reports}) with no changeset: run \`pnpm changeset\` and name it`
  })
}

function readCommitted(root: string, entry: Extraction['entry']): string | undefined {
  const path = join(root, entry.pkg.rel, entry.report)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Runs the sections and returns what each found. A section that throws is a failure of that
 * section, not of the run: every section reports.
 * @internal
 */
export function hygiene(options: HygieneOptions): readonly SectionResult[] {
  const workDir = mkdtempSync(join(tmpdir(), 'provino-hygiene-'))
  try {
    return SECTIONS.filter((section) => options.only?.includes(section) ?? true).map((section) => {
      try {
        return runSection(section, options, workDir)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { section, problems: [`could not run: ${message}`], notes: [] }
      }
    })
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
