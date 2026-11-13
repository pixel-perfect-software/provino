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
import { lintPackAsync } from './lint-pack.ts'
import { packPackageAsync } from './pack.ts'
import { runtimeDependencyNames } from './package-json.ts'
import { CONCURRENCY, mapPool } from './pool.ts'
import { lintReleaseWorkflow } from './release-lint.ts'
import {
  publicPackages,
  readWorkspacePackages,
  SEMVER_PACKAGES,
  type WorkspacePackage,
} from './workspace.ts'

/** A check of `pnpm hygiene`: the keys of `RUNNERS`, below. */
export type Section =
  | 'install-scripts'
  | 'changeset-config'
  | 'umbrella-deps'
  | 'release'
  | 'packs'
  | 'knip'
  | 'api'

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
 * The `@provino/*` packages `provino` inlines: the ones it lists as workspace dev dependencies and,
 * closed over their runtime dependencies, the ones those need.
 * @internal
 */
export function inlinedPackages(
  packages: readonly WorkspacePackage[],
): readonly WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))
  const inlined = new Map<string, WorkspacePackage>()
  const queue = Object.keys(byName.get('provino')?.manifest.devDependencies ?? {}).filter((name) =>
    name.startsWith('@provino/'),
  )
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const pkg = byName.get(name)
    if (pkg === undefined || inlined.has(name)) continue
    inlined.set(name, pkg)
    for (const dependency of runtimeDependencyNames(pkg.manifest)) {
      if (dependency.startsWith('@provino/')) queue.push(dependency)
    }
  }
  return [...inlined.values()]
}

/**
 * `provino` inlines every package `inlinedPackages` names, so the third-party packages they need
 * at run time must be `provino`'s own dependencies: a package missing there installs, then fails
 * to import. The reverse also fails: a dependency nothing inlined needs is dead weight on every
 * install.
 * @internal
 */
export function umbrellaDependencyProblems(
  packages: readonly WorkspacePackage[],
): readonly string[] {
  const umbrella = packages.find((pkg) => pkg.manifest.name === 'provino')
  if (umbrella === undefined) return ['the `provino` package is missing']
  const needed = new Set(
    inlinedPackages(packages)
      .flatMap((pkg) => runtimeDependencyNames(pkg.manifest))
      .filter((name) => !name.startsWith('@provino/')),
  )
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

/** What a section found, before it is named. */
interface SectionParts {
  readonly problems: readonly string[]
  readonly notes: readonly string[]
}

/** What every section is given: the options, the workspace (read once) and a scratch directory. */
interface SectionContext {
  readonly options: HygieneOptions
  readonly packages: readonly WorkspacePackage[]
  readonly workDir: string
}

type SectionRunner = (context: SectionContext) => SectionParts | Promise<SectionParts>

/** Lets the event loop run: the in-process API Extractor yields between entries so children progress. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * The checks, by section. The order is the order they are reported in, and the order they start
 * in: `packs` and `knip` wait on child processes, so they start before `api`, which works in this
 * process, and the three overlap.
 */
const RUNNERS: Readonly<Record<Section, SectionRunner>> = {
  'install-scripts': ({ packages }) => ({
    problems: installScriptProblems(packages),
    notes: [`${packages.length} package.json files checked`],
  }),
  'changeset-config': ({ options, packages }) => ({
    problems: checkChangesetIgnore(readChangesetConfig(options.root).ignore, packages),
    notes: [],
  }),
  'umbrella-deps': ({ packages }) => ({
    problems: umbrellaDependencyProblems(packages),
    notes: [],
  }),
  release: ({ options }) => {
    const problems: string[] = []
    const notes: string[] = []
    const template = readFileSync(join(options.root, RELEASE_TEMPLATE), 'utf8')
    for (const problem of lintReleaseWorkflow(template, { draft: true })) {
      problems.push(`${RELEASE_TEMPLATE}: ${problem}`)
    }
    if (existsSync(join(options.root, RELEASE_WORKFLOW))) {
      const text = readFileSync(join(options.root, RELEASE_WORKFLOW), 'utf8')
      for (const problem of lintReleaseWorkflow(text, { draft: /\bDRAFT\b/.test(text) })) {
        problems.push(`${RELEASE_WORKFLOW}: ${problem}`)
      }
    } else {
      notes.push(`${RELEASE_WORKFLOW} does not exist yet (B21h adds it from the template)`)
    }
    return { problems, notes }
  },
  // Pack, then publint and attw, one package at a time per lane, a few lanes at once. The results
  // come back in package order, so the report reads the same as when they ran one after another.
  packs: async ({ options, workDir }) => {
    const found = await mapPool(publicPackages(options.root), CONCURRENCY, async (pkg) =>
      lintPackAsync(await packPackageAsync(pkg, join(workDir, 'packs')), options.root),
    )
    return {
      problems: found.flat().map((problem) => {
        return `${problem.tool} failed on ${problem.name}:\n${problem.output.trim()}`
      }),
      notes: [`${found.length} packs checked with publint and attw (--profile esm-only)`],
    }
  },
  knip: async ({ options }) => {
    const result = await runKnip(options.root)
    return {
      problems: result.ok ? [] : [`knip found problems:\n${result.output.trim()}`],
      notes: [],
    }
  },
  api: async ({ options, packages, workDir }) => {
    const problems: string[] = []
    const notes: string[] = []
    const extractions: Extraction[] = []
    for (const entry of apiEntries(packages)) {
      extractions.push(extract(entry, join(workDir, 'api')))
      await turn()
    }
    for (const { entry, errors } of extractions) {
      for (const error of errors) {
        problems.push(`${entry.pkg.manifest.name} (${entry.name}): ${error}`)
      }
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
    return { problems, notes }
  },
}

/** The checks `pnpm hygiene` runs, in the order they are reported. */
export const SECTIONS: readonly Section[] = Object.keys(RUNNERS) as Section[]

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
 * Runs the sections together and returns what each found, in section order. A section that
 * throws is a failure of that section, not of the run: every section reports.
 * @internal
 */
export async function hygiene(options: HygieneOptions): Promise<readonly SectionResult[]> {
  const workDir = mkdtempSync(join(tmpdir(), 'provino-hygiene-'))
  try {
    const context: SectionContext = {
      options,
      packages: readWorkspacePackages(options.root),
      workDir,
    }
    const selected = SECTIONS.filter((section) => options.only?.includes(section) ?? true)
    return await Promise.all(
      selected.map(async (section): Promise<SectionResult> => {
        try {
          return { section, ...(await RUNNERS[section](context)) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { section, problems: [`could not run: ${message}`], notes: [] }
        }
      }),
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
