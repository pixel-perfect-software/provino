// Row 12 of B27's acceptance, the pure half: what node --test reported before the rewrite and what
// Provino reports after it, as comparable records (test names are the title path joined with
// ' > '), and the difference between the two. Nothing here starts a process.
import { relative } from 'node:path'
import { MigrateError } from './errors.ts'

/** A status both runners can report. */
export type MigrateStatus = 'pass' | 'fail' | 'skip' | 'todo'

/**
 * One test: its file (relative to the package, POSIX), its title path joined with ' > ', its status.
 * A `suite` record stands for a skipped suite whose tests node:test never reports (see
 * `recordsFromReporter`).
 * @internal
 */
export interface TestRecord {
  readonly file: string
  readonly name: string
  readonly status: MigrateStatus
  readonly suite?: true
}

/**
 * One line of `node-test-reporter.ts`'s output.
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

interface Entry {
  readonly line: ReporterLine
  readonly children: Entry[]
}

/**
 * Rebuilds the title paths from the reporter's lines. Node reports a suite after its children, in
 * definition order, so a line at nesting n owns the unclaimed lines at n + 1 before it. A line with
 * no file is dropped. A skip or todo on a suite is carried down to the tests it reports; a skipped
 * suite is not run, so node:test reports none of its tests: it stays one `suite` record, which
 * `diffRecords` matches against the tests Provino lists under it as skipped.
 * @internal
 */
export function recordsFromReporter(
  lines: readonly ReporterLine[],
  packageDir: string,
): TestRecord[] {
  const stack: Entry[] = []
  for (const line of lines) {
    if (line.file === '') continue
    const children: Entry[] = []
    while ((stack.at(-1)?.line.nesting ?? -1) > line.nesting) {
      const child = stack.pop()
      if (child !== undefined) children.push(child)
    }
    stack.push({ line, children: children.reverse() })
  }
  const records: TestRecord[] = []
  const walk = (
    entry: Entry,
    path: readonly string[],
    inherited: MigrateStatus | null,
  ): boolean => {
    const { line } = entry
    const here = [...path, line.name]
    const file = relative(packageDir, line.file).split('\\').join('/')
    const own: MigrateStatus | null = line.skip ? 'skip' : line.todo ? 'todo' : null
    const carried = inherited === 'skip' ? 'skip' : (own ?? inherited)
    if (line.suite) {
      let failed = false
      for (const child of entry.children) failed = walk(child, here, carried) || failed
      if (carried === 'skip' && entry.children.length === 0) {
        records.push({ file, name: here.join(SEPARATOR), status: 'skip', suite: true })
      } else if (!line.pass && !failed) {
        // A suite that failed with no failing child (a throwing hook) is a failure of its own.
        records.push({ file, name: here.join(SEPARATOR), status: 'fail' })
        return true
      }
      return failed
    }
    const status: MigrateStatus = !line.pass ? 'fail' : (carried ?? 'pass')
    records.push({ file, name: here.join(SEPARATOR), status })
    return status === 'fail'
  }
  for (const entry of stack) walk(entry, [], null)
  return records
}

interface ProvinoTest {
  readonly id: { readonly path: readonly string[] }
  readonly status: string
}
interface ProvinoFile {
  readonly file: string
  readonly status: string
  readonly fileError?: { readonly message?: string }
  readonly tests: readonly ProvinoTest[]
}

const PROVINO_STATUS: Readonly<Record<string, MigrateStatus>> = {
  passed: 'pass',
  failed: 'fail',
  skipped: 'skip',
  todo: 'todo',
}

/**
 * The records of a Provino `json` reporter run (a `NormalizedRun`). A file that crashed, or a
 * status with no node:test equivalent, is a `MIGRATE_RUN` error: it cannot be compared.
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
        `Provino could not run ${file.file} (the file crashed: ${file.fileError?.message ?? 'no message'})`,
      )
    }
    for (const test of file.tests) {
      const status = PROVINO_STATUS[test.status]
      if (status === undefined) {
        throw new MigrateError(
          'MIGRATE_RUN',
          `${file.file}: test status ${test.status} has no node:test equivalent`,
        )
      }
      records.push({ file: file.file, name: test.id.path.join(SEPARATOR), status })
    }
  }
  return records
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

const keyOf = (record: TestRecord): string => `${record.file}\0${record.name}\0${record.status}`
const nameKey = (record: TestRecord): string => `${record.file}\0${record.name}`

/**
 * Compares what node:test reported (`before`) with what Provino reports (`after`). Each `suite`
 * record in `before` is a skipped suite: the tests Provino lists under it as skipped are expected,
 * and anything else under it stays a difference.
 * @internal
 */
export function diffRecords(
  before: readonly TestRecord[],
  after: readonly TestRecord[],
): Difference {
  const suites = before.filter((record) => record.suite === true)
  const expected = before.filter((record) => record.suite !== true)
  const actual = after.filter(
    (record) =>
      !(
        record.status === 'skip' &&
        suites.some(
          (suite) =>
            suite.file === record.file && record.name.startsWith(`${suite.name}${SEPARATOR}`),
        )
      ),
  )

  const counts = new Map<string, number>()
  for (const record of expected) {
    const key = keyOf(record)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const leftover: TestRecord[] = []
  for (const record of actual) {
    const key = keyOf(record)
    const count = counts.get(key) ?? 0
    if (count > 0) counts.set(key, count - 1)
    else leftover.push(record)
  }
  // What node:test reported and Provino did not, by file and name, to pair with a changed status.
  const byName = new Map<string, TestRecord[]>()
  for (const record of leftover) {
    const key = nameKey(record)
    byName.set(key, [...(byName.get(key) ?? []), record])
  }
  const missing: TestRecord[] = []
  const changed: { file: string; name: string; before: MigrateStatus; after: MigrateStatus }[] = []
  const paired = new Set<TestRecord>()
  for (const record of expected) {
    const key = keyOf(record)
    const count = counts.get(key) ?? 0
    if (count === 0) continue
    counts.set(key, count - 1)
    const match = byName.get(nameKey(record))?.shift()
    if (match === undefined) {
      missing.push(record)
    } else {
      paired.add(match)
      changed.push({
        file: record.file,
        name: record.name,
        before: record.status,
        after: match.status,
      })
    }
  }
  return { missing, extra: leftover.filter((record) => !paired.has(record)), changed }
}

/** @internal */
export function isEmptyDifference(difference: Difference): boolean {
  return difference.missing.length + difference.extra.length + difference.changed.length === 0
}

/** @internal */
export function formatDifference(difference: Difference): string {
  const lines: string[] = []
  for (const r of difference.missing) lines.push(`  missing  ${r.file}: ${r.name} (${r.status})`)
  for (const r of difference.extra) lines.push(`  extra    ${r.file}: ${r.name} (${r.status})`)
  for (const c of difference.changed) {
    lines.push(`  changed  ${c.file}: ${c.name} (${c.before} -> ${c.after})`)
  }
  return lines.join('\n')
}
