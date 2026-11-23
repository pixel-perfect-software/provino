// `rewrite` and `verify` for one package (B27g1). The design: `rewrite` records what
// `node --test` reports for the files it is about to change into a baseline file (outside the
// tree, so no stash or second checkout is needed), then writes the rewrites; `verify` runs Provino
// on the same files and compares. A package with any refusal is not touched at all, so the
// baseline and the files never disagree about which tests exist.
import { existsSync } from 'node:fs'
import { glob, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { INCLUDE_GLOBS, bootstrapFiles as listBootstrapFiles, TEST_RUNNER } from '../dogfood.ts'
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

/**
 * The files that stay on node:test (B27g2: `tooling/provino/bootstrap.json`), relative to the
 * package; `rewrite` leaves them alone, so the baseline and the files agree on what is migrated.
 */
async function bootstrapFiles(root: string, packageDir: string): Promise<ReadonlySet<string>> {
  let files: readonly string[]
  try {
    files = listBootstrapFiles(root)
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return new Set()
    throw new MigrateError('MIGRATE_BASELINE', 'cannot read tooling/provino/bootstrap.json', {
      cause,
    })
  }
  return new Set(files.map((file) => relative(packageDir, join(root, file))))
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
  /** No file imports node:test any more: the baseline, if any, was left as it is. */
  readonly nothingToMigrate: boolean
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
  const scriptText = readManifest(packageDir).scripts.test
  const script = parseTestScript(scriptText)
  // An already-migrated package's script runs the runner, so its files are found by the include
  // rule its config uses, not by the script's globs (which name only the bootstrap files).
  const migrated =
    scriptText === TEST_RUNNER || scriptText?.startsWith(`${TEST_RUNNER} && `) === true
  const globs = migrated ? INCLUDE_GLOBS : script.globs
  const staying = await bootstrapFiles(root, packageDir)
  const files = (await testFiles(packageDir, globs)).filter((file) => !staying.has(file))
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
    return {
      candidates,
      refusals,
      rewritten: [],
      baselineTests: 0,
      nothingToMigrate: candidates === 0,
    }
  }

  const target = baselinePath(options.cacheDir, packageDir, root)
  const previous = (await readBaseline(target))?.files ?? {}
  const names = changed.map((result) => result.file)
  const records = await recordNodeTest(packageDir, names, script.flags)
  const fresh = new Map<string, TestRecord[]>(names.map((name) => [name, []]))
  for (const record of records) fresh.get(record.file)?.push(record)
  // Files migrated before stay, bootstrapped ones too (verify leaves those out); only entries for
  // files that are gone from disk, or being recorded now, go: a baseline never loses a file otherwise.
  const kept = Object.entries(previous).filter(
    ([file]) => existsSync(join(packageDir, file)) && !fresh.has(file),
  )
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
  return {
    candidates,
    refusals,
    rewritten: names,
    baselineTests: records.length,
    nothingToMigrate: false,
  }
}

/**
 * What `verify` compared.
 * @internal
 */
export interface VerifyReport {
  readonly tests: number
  /** Baseline files left out because they are in the bootstrap set (they stay on node:test). */
  readonly leftOutFiles: number
  /** The tests those files held. */
  readonly leftOutTests: number
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
  const staying = await bootstrapFiles(root, packageDir)
  const all = Object.keys(baseline.files).sort()
  const files = all.filter((file) => !staying.has(file))
  const left = all.filter((file) => staying.has(file))
  const leftOutTests = left.reduce((sum, file) => sum + (baseline.files[file]?.length ?? 0), 0)
  const before = files.flatMap((file) => baseline.files[file] ?? [])
  if (before.length === 0) {
    throw new MigrateError(
      'MIGRATE_NO_BASELINE',
      `the baseline at ${target} holds no test outside the bootstrap set (${left.length} file(s) left out): nothing to verify`,
    )
  }
  // The package's own config (its timeouts, D194) when it has one: it runs the whole package, so
  // only the files the baseline holds are compared.
  const own = join(packageDir, 'provino.config.ts')
  const wanted = new Set(files)
  const after = (
    await recordProvino({
      packageDir,
      files,
      runner: options.runner,
      config: options.config ?? (existsSync(own) ? own : undefined),
    })
  ).filter((record) => wanted.has(record.file))
  return {
    tests: before.length,
    leftOutFiles: left.length,
    leftOutTests,
    difference: diffRecords(before, after),
  }
}
