// \`rewrite\` and \`verify\` for one package (B27g1). The design: \`rewrite\` records what
// \`node --test\` reports for the files it is about to change into a baseline file (outside the
// tree, so no stash or second checkout is needed), then writes the rewrites; \`verify\` runs Provino
// on the same files and compares. A package with any refusal is not touched at all, so the
// baseline and the files never disagree about which tests exist.
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { MigrateError } from './errors.ts'
import { type Refusal, rewriteNodeTest } from './node-test-rewrite.ts'
import {
  type Difference,
  diffRecords,
  recordNodeTest,
  recordProvino,
  type TestRecord,
} from './node-test-verify.ts'

const DEFAULT_GLOBS = ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.test.ts']

/** The baseline's file shape. */
interface Baseline {
  readonly package: string
  readonly nodeVersion: string
  /** By file, relative to the package. */
  readonly files: Readonly<Record<string, readonly TestRecord[]>>
}

/** @internal */
export function baselinePath(cacheDir: string, packageDir: string, root: string): string {
  const name = relative(root, packageDir).split(/[\\/]/).join('__')
  return join(cacheDir, name + '.baseline.json')
}

async function readScript(packageDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>
  }
  return manifest.scripts?.test ?? ''
}

/**
 * The globs a package's \`test\` script names (its quoted \`*.ts\` patterns), else the usual three.
 * @internal
 */
export function testGlobs(script: string): string[] {
  const found = [...script.matchAll(/"([^"]*\*[^"]*\.ts)"/g)].map((m) => m[1] ?? '')
  return found.length > 0 ? found : DEFAULT_GLOBS
}

/**
 * The node flags the test script passes (\`--conditions=provino-source\`, \`--import …\`): the ones
 * that change how a file loads, not the ones that pick tests, shards or reporters.
 * @internal
 */
export function testFlags(script: string): string[] {
  return script
    .split(/\s+/)
    .filter((token) => token.startsWith('--') && token !== '--test')
    .filter((token) => !/^--test-(shard|reporter|only)/.test(token))
}

async function testFiles(packageDir: string): Promise<string[]> {
  const globs = testGlobs(await readScript(packageDir))
  const files = new Set<string>()
  for (const pattern of globs) {
    for await (const file of glob(pattern, {
      cwd: packageDir,
      exclude: (name) => name === 'node_modules',
    })) {
      files.add(String(file).split('\\').join('/'))
    }
  }
  return [...files].sort()
}

/**
 * What \`rewrite\` did.
 * @internal
 */
export interface RewriteReport {
  /** Files that import node:test. */
  readonly candidates: number
  readonly refusals: readonly Refusal[]
  /** Files rewritten (none under \`dryRun\` or with a refusal). */
  readonly rewritten: readonly string[]
  readonly baselineTests: number
}

/** @internal */
export async function rewritePackage(options: {
  readonly packageDir: string
  readonly root: string
  readonly cacheDir: string
  readonly dryRun: boolean
}): Promise<RewriteReport> {
  const { packageDir } = options
  const script = await readScript(packageDir)
  const files = await testFiles(packageDir)
  const results: { file: string; text: string; changed: boolean }[] = []
  const refusals: Refusal[] = []
  let candidates = 0
  for (const file of files) {
    const source = await readFile(join(packageDir, file), 'utf8')
    const result = rewriteNodeTest(relative(options.root, join(packageDir, file)), source)
    if (result.changed || result.refusals.length > 0) candidates++
    refusals.push(...result.refusals)
    if (result.changed) results.push({ file, text: result.text, changed: true })
  }
  if (refusals.length > 0 || options.dryRun) {
    return { candidates, refusals, rewritten: [], baselineTests: 0 }
  }
  if (results.length === 0) return { candidates, refusals, rewritten: [], baselineTests: 0 }

  const target = baselinePath(options.cacheDir, packageDir, options.root)
  let previous: Baseline['files'] = {}
  try {
    previous = (JSON.parse(await readFile(target, 'utf8')) as Baseline).files
  } catch {
    // No baseline yet.
  }
  const names = results.map((r) => r.file)
  const records = await recordNodeTest(packageDir, names, testFlags(script))
  const grouped = new Map<string, TestRecord[]>(names.map((name) => [name, []]))
  for (const record of records) grouped.get(record.file)?.push(record)
  const byFile: Record<string, readonly TestRecord[]> = {
    ...previous,
    ...Object.fromEntries(grouped),
  }
  const baseline: Baseline = {
    package: relative(options.root, packageDir),
    nodeVersion: process.version,
    files: byFile,
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(baseline, null, 2) + '\n')
  for (const result of results) await writeFile(join(packageDir, result.file), result.text)
  return { candidates, refusals, rewritten: names, baselineTests: records.length }
}

/**
 * What \`verify\` compared.
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
  const target = baselinePath(options.cacheDir, options.packageDir, options.root)
  let baseline: Baseline
  try {
    baseline = JSON.parse(await readFile(target, 'utf8')) as Baseline
  } catch (cause) {
    throw new MigrateError(
      'MIGRATE_NO_BASELINE',
      'no baseline at ' + target + ': run rewrite on this package first',
      { cause },
    )
  }
  const files = Object.keys(baseline.files).sort()
  const before = files.flatMap((file) => baseline.files[file] ?? [])
  const after = await recordProvino({
    packageDir: options.packageDir,
    files,
    runner: options.runner,
    config: options.config,
  })
  return { tests: before.length, difference: diffRecords(before, after) }
}
