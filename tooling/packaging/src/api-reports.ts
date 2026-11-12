import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
  type ExtractorMessage,
} from '@microsoft/api-extractor'
import { entriesOf } from './preset.ts'
import { SEMVER_PACKAGES, type WorkspacePackage } from './workspace.ts'

/** One entry point of a package whose API is reported. */
export interface ApiEntry {
  readonly pkg: WorkspacePackage
  /** `index`, `node`, `runtime/index`: the entry's name in `dist/`. */
  readonly name: string
  /** The declaration file API Extractor reads, absolute. */
  readonly dts: string
  /** The committed report, relative to the package: `etc/provino-node.api.md`. */
  readonly report: string
}

/** The file stem of an entry's report: the package, then the entry if it isn't the root. */
function reportStem(pkg: WorkspacePackage, name: string): string {
  const unscoped = pkg.manifest.name.replace(/^@[^/]+\//, '')
  return name === 'index'
    ? unscoped
    : `${unscoped}-${name.replaceAll('/', '-').replace(/-index$/, '')}`
}

/**
 * The entry points whose API is reported: every `exports` entry with a source file, of the
 * packages D67 promises semver for.
 * @internal
 */
export function apiEntries(packages: readonly WorkspacePackage[]): readonly ApiEntry[] {
  return packages
    .filter((pkg) => SEMVER_PACKAGES.includes(pkg.manifest.name))
    .flatMap((pkg) =>
      entriesOf(pkg.manifest).map((entry) => ({
        pkg,
        name: entry.name,
        dts: join(pkg.dir, 'dist', `${entry.name}.d.ts`),
        report: `etc/${reportStem(pkg, entry.name)}.api.md`,
      })),
    )
}

/** What API Extractor made of one entry point. */
export interface Extraction {
  readonly entry: ApiEntry
  /** Messages at error level: an export with no release tag, an unresolvable import. */
  readonly errors: readonly string[]
  /** The report API Extractor generated now (`undefined` when it failed before making one). */
  readonly report: string | undefined
}

/**
 * Runs API Extractor on an entry point's built declarations. `ae-missing-release-tag` is an
 * error: an export with none of `@public`, `@beta` or `@internal` fails (Track 1 §Types and public
 * API). Forgotten exports are not reported: a bundled declaration file keeps the types it
 * doesn't export. The generated report is returned, never written beside the committed one.
 * @internal
 */
export function extract(entry: ApiEntry, workDir: string): Extraction {
  if (!existsSync(entry.dts)) {
    return {
      entry,
      errors: [`${entry.dts} does not exist: build the package first`],
      report: undefined,
    }
  }
  const stem = reportStem(entry.pkg, entry.name)
  const reportFolder = join(workDir, stem, 'report')
  mkdirSync(reportFolder, { recursive: true })
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: entry.pkg.dir,
      newlineKind: 'lf',
      mainEntryPointFilePath: entry.dts,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2024',
            lib: ['es2024'],
            types: ['node'],
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          files: [entry.dts],
        },
      },
      apiReport: {
        enabled: true,
        reportFolder,
        reportTempFolder: join(workDir, stem, 'temp'),
        reportFileName: `${stem}.api.md`,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Error } },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Warning, addToApiReportFile: false },
          'ae-missing-release-tag': {
            logLevel: ExtractorLogLevel.Error,
            addToApiReportFile: false,
          },
          'ae-forgotten-export': { logLevel: ExtractorLogLevel.None, addToApiReportFile: false },
        },
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    },
    configObjectFullPath: join(entry.pkg.dir, 'api-extractor.json'),
    packageJsonFullPath: join(entry.pkg.dir, 'package.json'),
  })
  const errors: string[] = []
  const result = Extractor.invoke(config, {
    // `localBuild` writes the report instead of failing on a difference: the comparison with the
    // committed report is `checkReports`' job, and it needs a changeset, not just a rewrite.
    localBuild: true,
    messageCallback(message: ExtractorMessage) {
      message.handled = true
      if (message.logLevel === ExtractorLogLevel.Error) {
        const where =
          message.sourceFilePath === undefined
            ? ''
            : ` (${message.sourceFilePath}:${message.sourceFileLine ?? 0})`
        errors.push(`${message.messageId}: ${message.text}${where}`)
      }
    },
  })
  const file = join(reportFolder, `${stem}.api.md`)
  const report = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (!result.succeeded && errors.length === 0) errors.push('API Extractor failed')
  return { entry, errors, report }
}

/** One top-level declaration of a report, and the release tag above it. */
interface ReportBlock {
  readonly tag: 'public' | 'beta' | 'alpha' | 'internal' | 'none'
  readonly text: string
}

/**
 * The declarations of an API report: its code fence, split at blank lines, each with its release
 * tag (the `// @public` comment API Extractor writes above it).
 * @internal
 */
export function reportBlocks(report: string): readonly ReportBlock[] {
  const fence = /```ts\n([\s\S]*?)\n```/.exec(report)?.[1] ?? ''
  return fence
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((text) => {
      const tag = /^\/\/ @(public|beta|alpha|internal)\b/m.exec(text)?.[1]
      return { tag: (tag ?? 'none') as ReportBlock['tag'], text }
    })
}

/**
 * Whether a `@public` declaration was added, removed or changed between two reports. A change to
 * a `@beta` or `@internal` one is not a change to what users can rely on. A tier change counts
 * when either side is `@public`.
 * @internal
 */
export function publicApiChanged(before: string | undefined, after: string | undefined): boolean {
  const publicTexts = (report: string | undefined): ReadonlySet<string> =>
    new Set(
      report === undefined
        ? []
        : reportBlocks(report)
            .filter((block) => block.tag === 'public')
            .map((block) => block.text),
    )
  const old = publicTexts(before)
  const now = publicTexts(after)
  return old.size !== now.size || [...now].some((text) => !old.has(text))
}

/** An entry whose generated report differs from the committed one. */
export interface ReportDifference {
  readonly entry: ApiEntry
  /** The committed report (`undefined` when none is committed yet). */
  readonly committed: string | undefined
  readonly current: string
  /** Whether a `@public` declaration changed: that needs a changeset. */
  readonly publicChanged: boolean
}

/**
 * The entries whose report on disk (`etc/`) is not what API Extractor generates now.
 * @internal
 */
export function reportDifferences(extractions: readonly Extraction[]): readonly ReportDifference[] {
  return extractions.flatMap(({ entry, report }) => {
    if (report === undefined) return []
    const path = join(entry.pkg.dir, entry.report)
    const committed = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    if (committed === report) return []
    return [
      { entry, committed, current: report, publicChanged: publicApiChanged(committed, report) },
    ]
  })
}

/**
 * Writes each generated report over the committed one.
 * @internal
 */
export function writeReports(differences: readonly ReportDifference[]): void {
  for (const { entry, current } of differences) {
    const path = join(entry.pkg.dir, entry.report)
    mkdirSync(join(entry.pkg.dir, 'etc'), { recursive: true })
    writeFileSync(path, current)
  }
}
