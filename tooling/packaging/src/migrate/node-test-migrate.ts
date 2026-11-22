// `rewrite` and `verify` for one package (B27g1). The design: `rewrite` records what
// `node --test` reports for the files it is about to change into a baseline file (outside the
// tree, so no stash or second checkout is needed), then writes the rewrites; `verify` runs Provino
// on the same files and compares. A package with any refusal is not touched at all, so the
// baseline and the files never disagree about which tests exist.
import { existsSync } from 'node:fs'
import { glob, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { readManifest } from '../package-json.ts'
import { ROOT, readWorkspacePackages } from '../workspace.ts'
import { MigrateError } from './errors.ts'
import {
  type Difference,
  diffRecords,
  type MigrateStatus,
  type TestRecord,
} from './node-test-compare.ts'
import { type Refusal, rewriteNodeTest } from './node-test-rewrite.ts'
import { parseTestScript, recordNodeTest, recordProvino } from './node-test-run.ts'

/**
 * The baseline file's shape. `package` and `nodeVersion` are provenance (what was recorded, and
 * under which Node): nothing reads them back.
 * @internal
 */
export interface Baseline {
  readonly package: string
  readonly nodeVersion: string
  /** By file, relative to the package. */
  readonly files: Readonly<Record<string, readonly TestRecord[]>>
}

const STATUSES: ReadonlySet<string> = new Set<MigrateStatus>(['pass', 'fail', 'skip', 'todo'])

function isRecord(value: unknown): value is TestRecord {
  const record = value as Partial<Record<keyof TestRecord, unknown>> | null
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.file === 'string' &&
    typeof record.name === 'string' &&
    typeof record.status === 'string' &&
    STATUSES.has(record.status)
  )
}

function isBaseline(value: unknown): value is Baseline {
  const baseline = value as Partial<Record<keyof Baseline, unknown>> | null
  if (typeof baseline !== 'object' || baseline === null) return false
  const { files } = baseline
  return (
    typeof baseline.package === 'string' &&
    typeof baseline.nodeVersion === 'string' &&
    typeof files === 'object' &&
    files !== null &&
    Object.values(files).every((records) => Array.isArray(records) && records.every(isRecord))
  )
}

/** @internal */
export function baselinePath(cacheDir: string, packageDir: string, root: string): string {
  return join(cacheDir, `${relative(root, packageDir).split(/[\\/]/).join('__')}.baseline.json`)
}

/**
 * The baseline at `path`, or `undefined` when there is none. A file that cannot be read, is not JSON
 * or has another shape is `MIGRATE_BASELINE`: the recording is not trusted, and not silently redone.
 * @internal
 */
export async function readBaseline(path: string): Promise<Baseline | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return undefined
    throw new MigrateError('MIGRATE_BASELINE', `cannot read the baseline ${path}`, { cause })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new MigrateError(
      'MIGRATE_BASELINE',
      `the baseline ${path} is not JSON: delete it and record again`,
      { cause },
    )
  }
  if (!isBaseline(parsed)) {
    throw new MigrateError(
      'MIGRATE_BASELINE',
      `the baseline ${path} has an unexpected shape: delete it and record again`,
    )
  }
  return parsed
}

/** @internal */
export async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`)
  } catch (cause) {
    throw new MigrateError('MIGRATE_WRITE', `cannot write the baseline ${path}`, { cause })
  }
}

/**
 * The directory of a package named by a path, a workspace name (`@provino/core`), a directory
 * (`packages/core`, `tooling/packaging`) or a bare directory name (`core`).
 * @internal
 */
export function findPackage(name: string, root: string = ROOT): string {
  const direct = resolve(name)
  if (existsSync(join(direct, 'package.json'))) return direct
  const found = readWorkspacePackages(root).find(
    (pkg) =>
      pkg.rel !== '.' &&
      (pkg.rel === name ||
        pkg.manifest.name === name ||
        pkg.rel === `packages/${name}` ||
        pkg.rel === `tooling/${name}`),
  )
  if (found === undefined) throw new MigrateError('MIGRATE_USAGE', `no package at ${name}`)
  return found.dir
}

/** The package's test files: what its script's globs match, sorted, once each. */
async function testFiles(packageDir: string, globs: readonly string[]): Promise<string[]> {
  const found = await Promise.all(
    globs.map(async (pattern) => {
      const files: string[] = []
      for await (const file of glob(pattern, {
        cwd: packageDir,
        exclude: (name) => name === 'node_modules',
      })) {
        files.push(String(file).split('\\').join('/'))
      }
      return files
    }),
  )
  return [...new Set(found.flat())].sort()
}

/**
 * What `rewrite` did.
 * @internal
 */
export interface RewriteReport {
  /** Files that import node:test. */
  readonly candidates: number
  readonly refusals: readonly Refusal[]
  /** Files rewritten (none under `dryRun` or with a refusal). */
  readonly rewritten: readonly string[]
  /** Tests recorded into the baseline for the files rewritten now. */
  readonly baselineTests: number
}

/** @internal */
export async function rewritePackage(options: {
  readonly packageDir: string
  readonly root: string
  readonly cacheDir: string
  readonly dryRun: boolean
}): Promise<RewriteReport> {
  const [root, packageDir] = await Promise.all([
    realpath(options.root),
    realpath(options.packageDir),
  ])
  const script = parseTestScript(readManifest(packageDir).scripts.test)
  const files = await testFiles(packageDir, script.globs)
  const results = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(join(packageDir, file), 'utf8')
      return { file, source, ...rewriteNodeTest(relative(root, join(packageDir, file)), source) }
    }),
  )
  const refusals = results.flatMap((result) => result.refusals)
  const changed = results.filter((result) => result.changed)
  const candidates = results.filter((result) => result.changed || result.refusals.length > 0).length
  if (refusals.length > 0 || options.dryRun || changed.length === 0) {
    return { candidates, refusals, rewritten: [], baselineTests: 0 }
  }

  const target = baselinePath(options.cacheDir, packageDir, root)
  const previous = (await readBaseline(target))?.files ?? {}
  const names = changed.map((result) => result.file)
  const records = await recordNodeTest(packageDir, names, script.flags)
  const fresh = new Map<string, TestRecord[]>(names.map((name) => [name, []]))
  for (const record of records) fresh.get(record.file)?.push(record)
  // Files migrated before stay; entries for files that are gone, or are being recorded now, go.
  const kept = Object.entries(previous).filter(([file]) => files.includes(file) && !fresh.has(file))
  await writeBaseline(target, {
    package: relative(root, packageDir),
    nodeVersion: process.version,
    files: Object.fromEntries([...kept, ...fresh]),
  })

  const written: { path: string; original: string }[] = []
  try {
    for (const result of changed) {
      const path = join(packageDir, result.file)
      written.push({ path, original: result.source })
      await writeFile(path, result.text)
    }
  } catch (cause) {
    await Promise.allSettled(written.map(({ path, original }) => writeFile(path, original)))
    throw new MigrateError(
      'MIGRATE_WRITE',
      'cannot write the rewritten files: the originals were put back',
      { cause },
    )
  }
  return { candidates, refusals, rewritten: names, baselineTests: records.length }
}

/**
 * What `verify` compared.
 * @internal
 */
export interface VerifyReport {
  readonly tests: number
  readonly difference: Difference
}

/** @internal */
export async function verifyPackage(options: {
  readonly packageDir: string
  readonly root: string
  readonly cacheDir: string
  readonly runner: string
  readonly config: string | undefined
}): Promise<VerifyReport> {
  const [root, packageDir] = await Promise.all([
    realpath(options.root),
    realpath(options.packageDir),
  ])
  const target = baselinePath(options.cacheDir, packageDir, root)
  const baseline = await readBaseline(target)
  if (baseline === undefined) {
    throw new MigrateError(
      'MIGRATE_NO_BASELINE',
      `no baseline at ${target}: run rewrite on this package first`,
    )
  }
  const files = Object.keys(baseline.files).sort()
  const before = files.flatMap((file) => baseline.files[file] ?? [])
  const after = await recordProvino({
    packageDir,
    files,
    runner: options.runner,
    config: options.config,
  })
  return { tests: before.length, difference: diffRecords(before, after) }
}
