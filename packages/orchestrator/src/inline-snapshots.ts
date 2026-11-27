// Writing inline snapshots (B23d B1, D113): a worker records the edits a test file asks for on
// `fileDone` (`SnapshotFileReport.inline`); the coordinator loads the dialect's writer
// (`snapshot.inline.writer`) the first time a run has edits and writes them, serialized per source
// file, since two test files can edit one source. A run that writes no inline snapshot never loads
// the writer. Neutral: what the writer is and how it formats is the dialect's.
//
// An edit's line and column are positions in the text its worker loaded. Once this run has written
// a source file, a worker may still hold the text from before (a file that loaded it in parallel,
// or a warm worker's record of it), so an edit for that file is written only when its
// `sourceHash` is the hash of the text on disk now; any other is refused with
// `SNAPSHOT_INLINE_STALE` and its test file fails, to be re-run. A write into a file this run
// hasn't written takes the edit as before: nothing in the run has changed that file.
import { readFile } from 'node:fs/promises'
import { createBehaviourLoader } from '@provino/policy'
import { inlineSourceHash, SnapshotError } from '@provino/snapshot/node'
import type {
  InlineSnapshotEdit,
  InlineSnapshotWriter,
  InlineSnapshotWriterFactory,
  ModuleRef,
  Policy,
} from '@provino/types'
import type { PoolOutcome } from './pool.ts'

/**
 * Writes a finished file's inline snapshots and returns its outcome: as it was, or, when the
 * writer threw (Jest's "Multiple inline snapshots for the same call"), the file failed with that
 * error and its snapshot report dropped, as Jest fails a file whose snapshots it couldn't save.
 * Nothing is written under update mode `none`.
 */
export async function withInlineSnapshots(
  outcome: PoolOutcome,
  writes: InlineSnapshotWrites,
  project: InlineSnapshotProject & { readonly update: 'all' | 'new' | 'none' },
  warn: (text: string) => void,
): Promise<PoolOutcome> {
  if (outcome.type !== 'done' || project.update === 'none') return outcome
  const edits = outcome.done.snapshot?.inline
  if (edits === undefined || edits.length === 0) return outcome
  try {
    for (const warning of await writes.apply(edits, project)) warn(warning)
    return outcome
  } catch (error) {
    return { type: 'failed', workerId: outcome.workerId, error }
  }
}

/** What applying one file's edits needs from its project. */
export interface InlineSnapshotProject {
  readonly rootDir: string
  readonly policy: Pick<Policy['snapshot'], 'inline'>
}

/** Applies each test file's inline edits; one per run. */
export interface InlineSnapshotWrites {
  /**
   * Writes `edits` with `project`'s writer, after every earlier write to the same source files.
   * Rejects with the writer's error (the file that asked then fails); resolves with its warnings.
   */
  apply(
    edits: readonly InlineSnapshotEdit[],
    project: InlineSnapshotProject,
  ): Promise<readonly string[]>
}

/**
 * Throws `SNAPSHOT_INLINE_STALE` when an edit of a file this run has already written was taken from
 * another text than the one on disk, or from one its worker couldn't name.
 */
async function refuseStale(
  edits: readonly InlineSnapshotEdit[],
  files: readonly string[],
  written: ReadonlySet<string>,
): Promise<void> {
  for (const file of files) {
    if (!written.has(file)) continue
    const now = inlineSourceHash(await readFile(file, 'utf8'))
    if (edits.some((edit) => edit.file === file && edit.sourceHash !== now)) {
      throw new SnapshotError(
        'SNAPSHOT_INLINE_STALE',
        `Inline snapshots could not be written into ${file}: another test file wrote inline snapshots into it during this run, after this test file loaded it, so the positions recorded here are out of date. Run the tests again to write them.`,
      )
    }
  }
}

/** Starts the run's inline snapshot writes. */
export function createInlineSnapshotWrites(): InlineSnapshotWrites {
  const loader = createBehaviourLoader()
  const writers = new Map<InlineSnapshotWriterFactory | string, Promise<InlineSnapshotWriter>>()
  /** The last write of each source file, which the next one waits for. */
  const tails = new Map<string, Promise<unknown>>()
  /** The source files this run has handed a writer: their text may not be what a worker loaded. */
  const written = new Set<string>()

  const writerOf = (
    ref: InlineSnapshotWriterFactory | ModuleRef<InlineSnapshotWriterFactory>,
  ): Promise<InlineSnapshotWriter> => {
    const key = typeof ref === 'function' ? ref : `${ref.module}#${ref.export}`
    let writer = writers.get(key)
    if (writer === undefined) {
      writer = (typeof ref === 'function' ? Promise.resolve(ref) : loader.load(ref)).then(
        (factory) => factory(),
      )
      writers.set(key, writer)
    }
    return writer
  }

  return {
    async apply(edits, project) {
      const ref = project.policy.inline.writer
      if (ref === null || edits.length === 0) return []
      const writer = await writerOf(ref)
      const files = [...new Set(edits.map((edit) => edit.file))]
      const before = Promise.allSettled(files.map((file) => tails.get(file)))
      const result = before.then(async () => {
        await refuseStale(edits, files, written)
        try {
          return await writer(edits, {
            rootDir: project.rootDir,
            prettierPath: project.policy.inline.prettierPath,
          })
        } finally {
          // Even a writer that threw may have written some of them.
          for (const file of files) written.add(file)
        }
      })
      const settled = result.catch(() => undefined)
      for (const file of files) tails.set(file, settled)
      return await result
    },
  }
}
