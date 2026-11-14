// The per-file snapshot state machine (T7.9), one instance per test file in the worker. It is
// Jest 30.5.2's `SnapshotState` (State.ts), step for step, with every difference between the
// dialects a policy value or the printer: the header, the key function, how a hint joins, the
// pretty-format options, and the words. Where Vitest 5.0.5's `SnapshotState` differs without a
// policy key behind it, the Jest rule stands and DIVERGENCES says so (the compare is exact, not
// trimmed; a skipped or failed test's snapshots count as checked; an existing file is rewritten
// only when something changed).
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import {
  addExtraLineBreaks,
  keyToTestName,
  normalizeNewlines,
  removeExtraLineBreaks,
  type SnapshotData,
  SnapshotError,
  type SnapshotUpdateMode,
  serializeSnapFile,
} from '@provino/snapshot'
import type {
  InlineSnapshotEdit,
  SnapshotFileReport,
  SnapshotKey,
  SnapshotPlugin,
  SnapshotPolicy,
  SnapshotPrinter,
} from '@provino/types'
import { readSnapFile, writeFileAtomically } from './files.ts'
import { topFrame } from './frame.ts'

/**
 * What a state is made from.
 * @public
 */
export interface SnapshotStateOptions {
  /** The test file. */
  readonly testPath: string
  /** Its `.snap` file. */
  readonly snapshotPath: string
  readonly update: SnapshotUpdateMode
  /** Whether diffs show every line. */
  readonly expand: boolean
  /** The slice's values the state reads. */
  readonly policy: Pick<
    SnapshotPolicy,
    'header' | 'keyJoin' | 'hintJoin' | 'format' | 'throwErrorBody'
  >
  /** The key of the n-th snapshot of a test (`SnapshotPolicy.key`, loaded). */
  readonly key: SnapshotKey
  readonly printer: SnapshotPrinter
  /** The project's serializers, the first one tried first. */
  readonly serializers?: readonly SnapshotPlugin[]
  /**
   * An inline snapshot that must be written is recorded for the coordinator's writer
   * (`SnapshotFileReport.inline`), as Jest's `_addSnapshot` does; without it (the policy has no
   * writer) such a snapshot fails instead.
   */
  readonly inlineWrites?: boolean
}

/**
 * One snapshot assertion.
 * @public
 */
export interface MatchOptions {
  /** The test's full name, with the hint joined on. */
  readonly testName: string
  /** The test, so a retry can take back what this attempt did. */
  readonly testId?: string
  readonly received: unknown
  readonly inlineSnapshot?: string
  readonly isInline: boolean
  /** The test is `test.failing`: a mismatch is the expected outcome and keeps what is stored. */
  readonly testFailing?: boolean
  /**
   * The stack of the inline matcher's call, its first frame the call (the worker's stacks are
   * source-mapped): where an inline snapshot that must be written goes.
   */
  readonly stack?: string
}

/**
 * How an assertion went.
 * @public
 */
export interface MatchResult {
  readonly pass: boolean
  /** The 1-based count of this snapshot in its test name. */
  readonly count: number
  readonly key: string
  /** The received value, serialized, without the extra line breaks; `''` on a pass. */
  readonly actual: string
  /** The stored snapshot, without the extra line breaks; `undefined` when there is none. */
  readonly expected: string | undefined
  /**
   * The snapshot would have been written into the test's source, and nothing writes there yet
   * (T7.11). `pass` is `false`.
   */
  readonly inlineNotWritten: boolean
}

/** A raw file's snapshot: `toMatchFileSnapshot`. */
interface RawSnapshot {
  readonly file: string
  readonly snapshot: string
}

interface Counts {
  added: number
  matched: number
  unmatched: number
  updated: number
}

/**
 * The dirty flag is monotonic, so undoing it per test needs proof that no other test wrote in
 * between: the value it had before this test's first write, and how many of the writes since then
 * were this test's own.
 */
interface AttemptWrites {
  readonly dirtyBefore: boolean
  ownWrites: number
  readonly writeCountBefore: number
}

/** Everything one test contributed since its attempt began, so a retry undoes exactly that. */
interface AttemptRecord {
  readonly checkedKeys: Set<string>
  readonly counters: Map<string, number | undefined>
  readonly counts: Counts
  readonly fileSnapshots: Map<string, string | undefined>
  /** The files (`matchRaw`) it queued to write. */
  readonly rawSnapshots: RawSnapshot[]
  /** The inline snapshots it queued to write. */
  readonly inlineEdits: InlineSnapshotEdit[]
  writes: AttemptWrites | undefined
}

/**
 * The snapshot state of one test file.
 * @public
 */
export class SnapshotState {
  readonly testPath: string
  readonly snapshotPath: string
  readonly update: SnapshotUpdateMode
  expand: boolean
  added = 0
  matched = 0
  unmatched = 0
  updated = 0

  private counters = new Map<string, number>()
  private dirty: boolean
  private fileExists: boolean
  private readonly data: SnapshotData
  private readonly uncheckedKeys: Set<string>
  private readonly rawSnapshots: RawSnapshot[] = []
  private readonly inlineEdits: InlineSnapshotEdit[] = []
  private readonly attempts = new Map<string, AttemptRecord>()
  private writeCount = 0
  private plugins: SnapshotPlugin[]

  private readonly options: SnapshotStateOptions

  constructor(options: SnapshotStateOptions) {
    this.options = options
    this.testPath = options.testPath
    this.snapshotPath = options.snapshotPath
    this.update = options.update
    this.expand = options.expand
    const read = readSnapFile(options.snapshotPath, options.update, options.policy.header)
    this.data = read.data
    this.dirty = read.dirty
    this.fileExists = read.exists
    this.uncheckedKeys = new Set(Object.keys(this.data))
    this.plugins = [...(options.serializers ?? [])]
  }

  /** The serializers in the order they are tried: the one added last first. */
  get serializers(): readonly SnapshotPlugin[] {
    return this.plugins
  }

  /** How a thrown error is stored by `toThrowErrorMatchingSnapshot` (`SnapshotPolicy.throwErrorBody`). */
  get throwErrorBody(): SnapshotPolicy['throwErrorBody'] {
    return this.options.policy.throwErrorBody
  }

  /**
   * A snapshot's test name: the title path joined by the key join, then the hint by the hint
   * join. Jest: `outer inner: hint`. Vitest: `outer > inner > hint`. A hint with no name is
   * dropped, as in Jest (`currentTestName && hint ? ... : currentTestName || ''`).
   */
  testName(titlePath: readonly string[], hint: string | undefined): string {
    const { keyJoin, hintJoin } = this.options.policy
    const name = titlePath.join(keyJoin)
    return name !== '' && hint !== undefined && hint !== '' ? `${name}${hintJoin}${hint}` : name
  }

  /** The dialect's words, for the matchers. */
  get messages(): SnapshotPrinter['messages'] {
    return this.options.printer.messages
  }

  /**
   * Adds a serializer ahead of the others (`expect.addSnapshotSerializer`). The printer's own
   * plugins come after all of them.
   */
  addSerializer(plugin: SnapshotPlugin): void {
    if (
      typeof plugin !== 'object' ||
      plugin === null ||
      typeof plugin.test !== 'function' ||
      !('serialize' in plugin
        ? typeof plugin.serialize === 'function'
        : typeof plugin.print === 'function')
    ) {
      throw new SnapshotError(
        'SNAPSHOT_BAD_SERIALIZER',
        'A snapshot serializer must be an object with a `test` function and a `serialize` (or `print`) function',
      )
    }
    this.plugins = [plugin, ...this.plugins]
  }

  /**
   * Marks the snapshots of a test that did not run to its end (skipped, todo or failed) as
   * checked, so they are not reported obsolete. A hint is joined to the name before the key is
   * built, so the name recovered from a hinted key is longer than the test's.
   */
  markCheckedForTest(testName: string): void {
    const { hintJoin } = this.options.policy
    for (const uncheckedKey of this.uncheckedKeys) {
      const keyTestName = keyToTestName(uncheckedKey)
      if (keyTestName === testName || keyTestName.startsWith(`${testName}${hintJoin}`)) {
        this.uncheckedKeys.delete(uncheckedKey)
      }
    }
  }

  /**
   * Takes back what a test's earlier attempt did (a retry, or a repeat): its counters, the
   * snapshots it added, the keys it checked and the totals. Other tests' work stays.
   */
  clearTest(testId: string): void {
    const record = this.attempts.get(testId)
    if (record === undefined) return
    this.attempts.delete(testId)
    this.added -= record.counts.added
    this.matched -= record.counts.matched
    this.unmatched -= record.counts.unmatched
    this.updated -= record.counts.updated
    for (const [key, previous] of record.fileSnapshots) {
      if (previous === undefined) delete this.data[key]
      else this.data[key] = previous
    }
    for (const raw of record.rawSnapshots)
      this.rawSnapshots.splice(this.rawSnapshots.indexOf(raw), 1)
    for (const edit of record.inlineEdits)
      this.inlineEdits.splice(this.inlineEdits.indexOf(edit), 1)
    for (const key of record.checkedKeys) this.uncheckedKeys.add(key)
    for (const [testName, previous] of record.counters) {
      if (previous === undefined) this.counters.delete(testName)
      else this.counters.set(testName, previous)
    }
    // The dirty flag can only be undone when every write since this test's first was its own; a
    // foreign write in between keeps the flag earned.
    const { writes } = record
    if (writes !== undefined && this.writeCount - writes.writeCountBefore === writes.ownWrites) {
      this.dirty = writes.dirtyBefore
      this.writeCount = writes.writeCountBefore
    }
  }

  /** The test is over: its attempt record is no longer needed. */
  forgetTest(testId: string): void {
    this.attempts.delete(testId)
  }

  /**
   * A snapshot that couldn't be taken (the property matchers failed): the count moves on and
   * the key is checked, so the test's other snapshots keep their numbers.
   */
  fail(testName: string, testId?: string): string {
    const count = this.bumpCounter(testName, testId)
    const key = this.options.key(testName, count)
    this.markKeyChecked(key, testId)
    this.incrementCount('unmatched', testId)
    return key
  }

  /** Compares one value with its stored snapshot, and writes it when the mode says to. */
  match(options: MatchOptions): MatchResult {
    const {
      testName,
      testId,
      received,
      inlineSnapshot,
      isInline,
      testFailing = false,
      stack,
    } = options
    const count = this.bumpCounter(testName, testId)
    const key = this.options.key(testName, count)

    // An inline snapshot beside a stored one doesn't check the stored key, so `-u` can remove it.
    if (!(isInline && this.data[key] !== undefined)) this.markKeyChecked(key, testId)

    const receivedSerialized = addExtraLineBreaks(this.serialize(received))
    const expected = isInline ? inlineSnapshot : this.data[key]
    const pass = expected === receivedSerialized
    const hasSnapshot = expected !== undefined
    const snapshotIsPersisted = isInline || this.fileExists

    if (pass && !isInline) {
      // Running a snapshot file and writing its strings back when other snapshots have changed
      // loses the escaping of some characters. Every snapshot of the file is checked, so the
      // newly serialized string is the one to keep.
      this.data[key] = receivedSerialized
    }

    // A run that only matches, because the test is expected to fail: no write, no report.
    if (testFailing) {
      if (hasSnapshot && !isInline) this.addSnapshot(key, expected, testId)
      return this.result(pass, count, key, receivedSerialized, expected, false)
    }

    // Write when there is no snapshot file in a non-CI run, when the mode is `all`, or when the
    // file lacks this snapshot; never under `none`.
    if (
      (hasSnapshot && this.update === 'all') ||
      ((!hasSnapshot || !snapshotIsPersisted) && (this.update === 'new' || this.update === 'all'))
    ) {
      if (isInline && this.options.inlineWrites !== true && !(pass && this.update === 'all')) {
        // The text would go into the test's source, and this policy has no writer.
        this.incrementCount('unmatched', testId)
        return this.result(false, count, key, receivedSerialized, expected, true)
      }
      const write = (): void =>
        isInline
          ? this.addInline(receivedSerialized, stack, testId)
          : this.addSnapshot(key, receivedSerialized, testId)
      if (this.update === 'all') {
        if (pass) {
          this.incrementCount('matched', testId)
        } else {
          this.incrementCount(hasSnapshot ? 'updated' : 'added', testId)
          write()
        }
      } else {
        write()
        this.incrementCount('added', testId)
      }
      return { pass: true, count, key, actual: '', expected: '', inlineNotWritten: false }
    }
    if (pass) {
      this.incrementCount('matched', testId)
      return { pass: true, count, key, actual: '', expected: '', inlineNotWritten: false }
    }
    this.incrementCount('unmatched', testId)
    return this.result(false, count, key, receivedSerialized, expected, false)
  }

  /**
   * Compares a raw string with the contents of a file (`toMatchFileSnapshot`): no serializing, no
   * extra line breaks, an exact compare. `existing` is the file's text, or `undefined` if it
   * doesn't exist.
   */
  matchRaw(options: {
    readonly testName: string
    readonly testId?: string
    readonly received: unknown
    readonly file: string
    readonly existing: string | undefined
  }): MatchResult {
    const { testName, testId, file, existing } = options
    const count = this.bumpCounter(testName, testId)
    const key = this.options.key(testName, count)
    this.markKeyChecked(key, testId)

    const received =
      typeof options.received === 'string' ? options.received : this.serialize(options.received)
    const pass = existing === received
    const hasSnapshot = existing !== undefined
    const result = (outcome: boolean): MatchResult => ({
      pass: outcome,
      count,
      key,
      actual: outcome ? '' : received,
      expected: outcome ? '' : existing,
      inlineNotWritten: false,
    })

    if (
      (hasSnapshot && this.update === 'all') ||
      (!hasSnapshot && (this.update === 'new' || this.update === 'all'))
    ) {
      if (this.update === 'all') {
        if (pass) {
          this.incrementCount('matched', testId)
        } else {
          this.incrementCount(hasSnapshot ? 'updated' : 'added', testId)
          this.addRaw(file, received, testId)
        }
      } else {
        this.addRaw(file, received, testId)
        this.incrementCount('added', testId)
      }
      return result(true)
    }
    if (pass) {
      this.incrementCount('matched', testId)
      return result(true)
    }
    this.incrementCount('unmatched', testId)
    return result(false)
  }

  getUncheckedCount(): number {
    return this.uncheckedKeys.size
  }

  getUncheckedKeys(): string[] {
    return [...this.uncheckedKeys]
  }

  /** Under `all`, forgets the obsolete snapshots, so the next save drops them. */
  removeUncheckedKeys(): void {
    if (this.update === 'all' && this.uncheckedKeys.size > 0) {
      this.dirty = true
      for (const key of this.uncheckedKeys) delete this.data[key]
      this.uncheckedKeys.clear()
    }
  }

  /**
   * Writes the `.snap` file (and any raw file) if something changed or something is obsolete,
   * and deletes it under `all` when nothing is left in it.
   */
  save(): { readonly saved: boolean; readonly deleted: boolean } {
    const hasSnapshots = Object.keys(this.data).length > 0
    const hasRaw = this.rawSnapshots.length > 0
    const isEmpty = !hasSnapshots && !hasRaw && this.inlineEdits.length === 0
    let saved = false
    let deleted = false

    if ((this.dirty || this.uncheckedKeys.size > 0) && !isEmpty) {
      if (hasSnapshots) {
        writeFileAtomically(
          this.snapshotPath,
          serializeSnapFile(this.data, this.options.policy.header),
        )
        this.fileExists = true
      }
      for (const raw of this.rawSnapshots) writeFileAtomically(raw.file, raw.snapshot)
      saved = true
    } else if (!hasSnapshots && existsSync(this.snapshotPath)) {
      if (this.update === 'all') unlinkSync(this.snapshotPath)
      deleted = true
    }
    return { saved, deleted }
  }

  /**
   * Ends the file: settles what is obsolete, saves, and reports. Call it after the file's skipped
   * and failed tests were marked with `markCheckedForTest`.
   */
  finish(): SnapshotFileReport {
    const uncheckedCount = this.getUncheckedCount()
    const uncheckedKeys = this.getUncheckedKeys()
    if (uncheckedCount > 0) this.removeUncheckedKeys()
    const status = this.save()
    return {
      file: existsSync(this.snapshotPath) ? this.snapshotPath : null,
      added: this.added,
      matched: this.matched,
      unmatched: this.unmatched,
      updated: this.updated,
      unchecked: status.deleted ? 0 : uncheckedCount,
      uncheckedKeys,
      fileDeleted: status.deleted,
      ...(status.saved && this.inlineEdits.length > 0 ? { inline: [...this.inlineEdits] } : {}),
    }
  }

  /** The contents of a raw snapshot file, or `undefined` when it doesn't exist. */
  static readRaw(file: string): string | undefined {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }

  private serialize(received: unknown): string {
    const { format } = this.options.policy
    const { escapeString, printBasicPrototype, maxOutputLength, extra } = format
    return normalizeNewlines(
      this.options.printer.serialize(received, {
        format: {
          escapeString,
          printBasicPrototype,
          ...(maxOutputLength === null ? {} : { maxOutputLength }),
          ...extra,
        },
        plugins: this.plugins,
      }),
    )
  }

  private result(
    pass: boolean,
    count: number,
    key: string,
    receivedSerialized: string,
    expected: string | undefined,
    inlineNotWritten: boolean,
  ): MatchResult {
    return {
      pass,
      count,
      key,
      actual: removeExtraLineBreaks(receivedSerialized),
      expected: expected === undefined ? undefined : removeExtraLineBreaks(expected),
      inlineNotWritten,
    }
  }

  private recordFor(testId: string | undefined): AttemptRecord | undefined {
    if (testId === undefined) return undefined
    let record = this.attempts.get(testId)
    if (record === undefined) {
      record = {
        checkedKeys: new Set(),
        counters: new Map(),
        counts: { added: 0, matched: 0, unmatched: 0, updated: 0 },
        fileSnapshots: new Map(),
        rawSnapshots: [],
        inlineEdits: [],
        writes: undefined,
      }
      this.attempts.set(testId, record)
    }
    return record
  }

  /** A key only reached by a discarded attempt has to go back to being unchecked. */
  private markKeyChecked(key: string, testId: string | undefined): void {
    if (this.uncheckedKeys.delete(key)) this.recordFor(testId)?.checkedKeys.add(key)
  }

  /**
   * Counters number keys per full test name, and full names can collide across tests. Undoing an
   * increment could double-undo a collision, so the record keeps each counter's value from before
   * the test first touched it.
   */
  private bumpCounter(testName: string, testId: string | undefined): number {
    const record = this.recordFor(testId)
    if (record !== undefined && !record.counters.has(testName)) {
      record.counters.set(testName, this.counters.get(testName))
    }
    const count = (this.counters.get(testName) ?? 0) + 1
    this.counters.set(testName, count)
    return count
  }

  private incrementCount(status: keyof Counts, testId: string | undefined): void {
    this[status]++
    const record = this.recordFor(testId)
    if (record !== undefined) record.counts[status]++
  }

  private noteWrite(testId: string | undefined): void {
    const record = this.recordFor(testId)
    if (record !== undefined) {
      record.writes ??= {
        dirtyBefore: this.dirty,
        ownWrites: 0,
        writeCountBefore: this.writeCount,
      }
      record.writes.ownWrites++
    }
    this.writeCount++
    this.dirty = true
  }

  private addSnapshot(key: string, receivedSerialized: string, testId: string | undefined): void {
    this.noteWrite(testId)
    // A retried attempt must not leave its writes behind, or the next attempt sees the key as
    // pre-existing and reports it as matched, not written.
    const record = this.recordFor(testId)
    if (record !== undefined && !record.fileSnapshots.has(key)) {
      record.fileSnapshots.set(key, this.data[key])
    }
    this.data[key] = receivedSerialized
  }

  /**
   * An inline snapshot to write (State.ts L167-L184): where the call is comes from the top frame
   * of its stack, so the coordinator's writer can find it in the source.
   */
  private addInline(snapshot: string, stack: string | undefined, testId: string | undefined): void {
    this.noteWrite(testId)
    const frame = stack === undefined ? undefined : topFrame(stack)
    if (frame === undefined) {
      throw new SnapshotError(
        'SNAPSHOT_NO_INLINE_FRAME',
        "Couldn't infer the stack frame of an inline snapshot, so it can't be written",
      )
    }
    const edit = { file: frame.file, line: frame.line, column: frame.column - 1, snapshot }
    this.inlineEdits.push(edit)
    this.recordFor(testId)?.inlineEdits.push(edit)
  }

  private addRaw(file: string, snapshot: string, testId: string | undefined): void {
    this.noteWrite(testId)
    const raw = { file, snapshot }
    this.rawSnapshots.push(raw)
    this.recordFor(testId)?.rawSnapshots.push(raw)
  }
}
