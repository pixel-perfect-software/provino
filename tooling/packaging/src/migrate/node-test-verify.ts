// Row 12 of B27's acceptance: nothing is lost in migration. The test names (title path joined
// with ' > ') and statuses node --test reported before the rewrite must equal what Provino
// reports after it.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MigrateError } from './errors.ts'

/** A status both runners can report. */
export type MigrateStatus = 'pass' | 'fail' | 'skip' | 'todo'

/**
 * One test: its file (relative to the package, POSIX), its title path joined with \` > \`, its status.
 * @internal
 */
export interface TestRecord {
  readonly file: string
  readonly name: string
  readonly status: MigrateStatus
}

/**
 * One line of \`node-test-reporter.ts\`'s output.
 * @internal
 */
export interface ReporterLine {
  readonly pass: boolean
  readonly nesting: number
  readonly name: string
  readonly file: string
  readonly suite: boolean
  readonly skip: boolean
  readonly todo: boolean
}

const SEPARATOR = ' > '

/**
 * Rebuilds the title paths from the reporter's lines. Node reports a suite after its children, in
 * definition order, so a line at nesting n owns the unclaimed lines at n + 1 before it.
 * @internal
 */
export function recordsFromReporter(
  lines: readonly ReporterLine[],
  packageDir: string,
): TestRecord[] {
  interface Entry {
    readonly line: ReporterLine
    children: Entry[]
  }
  const roots: Entry[] = []
  const stack: Entry[] = []
  for (const line of lines) {
    const entry: Entry = { line, children: [] }
    while (stack.length > 0 && (stack[stack.length - 1]?.line.nesting ?? -1) > line.nesting) {
      const child = stack.pop()
      if (child !== undefined) entry.children.unshift(child)
    }
    stack.push(entry)
  }
  roots.push(...stack)
  const records: TestRecord[] = []
  const walk = (entry: Entry, path: readonly string[]): boolean => {
    const here = [...path, entry.line.name]
    let childFailed = false
    for (const child of entry.children) childFailed = walk(child, here) || childFailed
    if (entry.line.suite) {
      // A suite that failed with no failing child (a throwing hook) is a failure of its own.
      if (!entry.line.pass && !childFailed) {
        records.push({
          file: relativeFile(entry.line.file, packageDir),
          name: here.join(SEPARATOR),
          status: 'fail',
        })
        return true
      }
      return childFailed
    }
    const status: MigrateStatus = !entry.line.pass
      ? 'fail'
      : entry.line.skip
        ? 'skip'
        : entry.line.todo
          ? 'todo'
          : 'pass'
    records.push({
      file: relativeFile(entry.line.file, packageDir),
      name: here.join(SEPARATOR),
      status,
    })
    return status === 'fail'
  }
  for (const root of roots) walk(root, [])
  return records
}

function relativeFile(file: string, packageDir: string): string {
  return relative(packageDir, file).split('\\').join('/')
}

interface ProvinoTest {
  readonly id: { readonly path: readonly string[] }
  readonly status: string
}
interface ProvinoFile {
  readonly file: string
  readonly fileError?: { readonly message?: string }
  readonly status: string
  readonly tests: readonly ProvinoTest[]
}

/**
 * The records of a Provino \`json\` reporter run (a \`NormalizedRun\`). A file that crashed, or a
 * status with no node:test equivalent, is a \`MIGRATE_RUN\` error: it cannot be compared.
 * @internal
 */
export function recordsFromProvino(run: unknown): TestRecord[] {
  const files = (run as { readonly files?: readonly ProvinoFile[] }).files
  if (!Array.isArray(files))
    throw new MigrateError('MIGRATE_RUN', "Provino's json report has no files")
  const records: TestRecord[] = []
  for (const file of files) {
    if (file.status === 'crashed') {
      throw new MigrateError(
        'MIGRATE_RUN',
        'Provino could not run ' +
          file.file +
          ' (the file crashed: ' +
          (file.fileError?.message ?? 'no message') +
          ')',
      )
    }
    for (const test of file.tests) {
      const status = PROVINO_STATUS[test.status]
      if (status === undefined) {
        throw new MigrateError(
          'MIGRATE_RUN',
          file.file + ': test status ' + test.status + ' has no node:test equivalent',
        )
      }
      records.push({ file: file.file, name: test.id.path.join(SEPARATOR), status })
    }
  }
  return records
}

const PROVINO_STATUS: Readonly<Record<string, MigrateStatus>> = {
  passed: 'pass',
  failed: 'fail',
  skipped: 'skip',
  todo: 'todo',
}

/**
 * How two runs differ. Tests are compared as a multiset of file, name and status, so a repeated
 * title is counted, not collapsed.
 * @internal
 */
export interface Difference {
  readonly missing: readonly TestRecord[]
  readonly extra: readonly TestRecord[]
  /** The same file and name, a different status: from node:test to Provino. */
  readonly changed: readonly {
    readonly file: string
    readonly name: string
    readonly before: MigrateStatus
    readonly after: MigrateStatus
  }[]
}

/** @internal */
export function diffRecords(
  before: readonly TestRecord[],
  after: readonly TestRecord[],
): Difference {
  const missing: TestRecord[] = []
  const extra: TestRecord[] = []
  const counts = new Map<string, number>()
  const key = (record: TestRecord): string =>
    record.file + '\0' + record.name + '\0' + record.status
  for (const record of before) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1)
  const leftover: TestRecord[] = []
  for (const record of after) {
    const count = counts.get(key(record)) ?? 0
    if (count > 0) counts.set(key(record), count - 1)
    else leftover.push(record)
  }
  const unmatched: TestRecord[] = []
  for (const record of before) {
    const count = counts.get(key(record)) ?? 0
    if (count > 0) {
      counts.set(key(record), count - 1)
      unmatched.push(record)
    }
  }
  const changed: { file: string; name: string; before: MigrateStatus; after: MigrateStatus }[] = []
  for (const record of unmatched) {
    const index = leftover.findIndex(
      (other) => other.file === record.file && other.name === record.name,
    )
    const match = leftover[index]
    if (match === undefined) {
      missing.push(record)
    } else {
      leftover.splice(index, 1)
      changed.push({
        file: record.file,
        name: record.name,
        before: record.status,
        after: match.status,
      })
    }
  }
  extra.push(...leftover)
  return { missing, extra, changed }
}

/** @internal */
export function isEmptyDifference(difference: Difference): boolean {
  return difference.missing.length + difference.extra.length + difference.changed.length === 0
}

/** @internal */
export function formatDifference(difference: Difference): string {
  const lines: string[] = []
  for (const r of difference.missing)
    lines.push('  missing  ' + r.file + ': ' + r.name + ' (' + r.status + ')')
  for (const r of difference.extra)
    lines.push('  extra    ' + r.file + ': ' + r.name + ' (' + r.status + ')')
  for (const c of difference.changed)
    lines.push('  changed  ' + c.file + ': ' + c.name + ' (' + c.before + ' -> ' + c.after + ')')
  return lines.join('\n')
}

/** The result of a child process. */
interface Exit {
  readonly code: number | null
  readonly output: string
}

function run(command: string, args: readonly string[], cwd: string): Promise<Exit> {
  return new Promise((done, fail) => {
    // A node:test child of a node:test run would skip its files (NODE_TEST_CONTEXT).
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', fail)
    child.on('close', (code) => done({ code, output }))
  })
}

const REPORTER = fileURLToPath(new URL('./node-test-reporter.ts', import.meta.url))

/** Flags a Node that does not strip types by default needs to run a \`.ts\` file. */
function stripFlags(): string[] {
  return process.features.typescript === false ? ['--experimental-strip-types'] : []
}

/**
 * Runs \`node --test\` over the files, as the package's test script does (\`flags\`), and returns what
 * it reported. A run where some test fails is still a baseline; a run that reports nothing is not.
 * @internal
 */
export async function recordNodeTest(
  packageDir: string,
  files: readonly string[],
  flags: readonly string[],
): Promise<TestRecord[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'provino-migrate-'))
  try {
    const destination = join(scratch, 'events.jsonl')
    const args = [
      ...stripFlags(),
      '--test',
      ...flags,
      '--test-reporter=' + REPORTER,
      '--test-reporter-destination=' + destination,
      ...files,
    ]
    const ended = await run(process.execPath, args, packageDir)
    let text = ''
    try {
      text = await readFile(destination, 'utf8')
    } catch {
      // Handled below, with the output.
    }
    const lines = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as ReporterLine)
    if (lines.length === 0) {
      throw new MigrateError(
        'MIGRATE_BASELINE',
        'node --test reported no tests (exit ' + String(ended.code) + '):\n' + ended.output,
      )
    }
    return recordsFromReporter(lines, packageDir)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Runs Provino's \`run\` over exactly the files, with a minimal config written outside the tree
 * (or the \`config\` given), and returns what its json reporter reported.
 * @internal
 */
export async function recordProvino(options: {
  readonly packageDir: string
  readonly files: readonly string[]
  readonly runner: string
  readonly config: string | undefined
}): Promise<TestRecord[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'provino-migrate-'))
  try {
    let config = options.config
    if (config === undefined) {
      config = join(scratch, 'provino.config.mjs')
      const body = {
        root: options.packageDir,
        include: options.files,
        resolve: { conditions: ['provino-source'] },
      }
      await writeFile(config, 'export default ' + JSON.stringify(body) + '\n')
    }
    const report = join(scratch, 'report.json')
    const runnerArgs = options.runner.endsWith('.ts') ? ['--conditions=provino-source'] : []
    const args = [
      ...stripFlags(),
      ...runnerArgs,
      resolve(options.runner),
      'run',
      '--config',
      resolve(config),
      '--reporter',
      'json',
      '--outputFile',
      report,
    ]
    const ended = await run(process.execPath, args, options.packageDir)
    let text: string
    try {
      text = await readFile(report, 'utf8')
    } catch (cause) {
      throw new MigrateError(
        'MIGRATE_RUN',
        'Provino wrote no report (exit ' + String(ended.code) + '):\n' + ended.output,
        { cause },
      )
    }
    return recordsFromProvino(JSON.parse(text))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
