// The "shared" verdicts a worker found (`ReevaluateState.shared`), kept beside the graph cache for
// the next run: an external a registry evaluated under a window that saw no per-file read or write
// loads natively from then on, so a warm run asks nothing again and stays as it was. Keyed as the
// graph is (the lockfile's hash and install marker, the resolver and the conditions), plus the
// policy's reevaluate keys, so a reinstall or another environment's conditions start afresh. A file
// is read once per worker and written once, from the loader's dispose, merged with the copy on disk
// through a temp file and a rename; one that is missing, damaged or of another key is no verdicts.
// The verdicts only spare work: losing them costs a cold run's first files, never correctness.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { threadId } from 'node:worker_threads'
import type { LoaderOptions } from '@provino/types'
import { conditionsOf } from '../graph/conditions.ts'
import { graphCacheKey } from '../graph/index.ts'
import type { ReevaluateState } from './reevaluate.ts'

const VERDICTS_FORMAT = 1

interface VerdictsFile {
  readonly format: number
  readonly key: string
  readonly shared: readonly string[]
}

/** Where the verdicts of a loader with `options` are kept, or `null` when they stay in memory. */
export function verdictsFileOf(options: LoaderOptions): { file: string; key: string } | null {
  if (options.graphCache == null) return null
  const policy = options.policy
  const key = graphCacheKey(
    options.root,
    [
      options.resolver.fingerprint,
      conditionsOf(options).join(','),
      `verdicts:${String(policy.reevaluateHookingExternals)}:${String(policy.reevaluatePatchingExternals)}`,
    ].join('\0'),
    options.lockfileHash ?? null,
  )
  return key === null
    ? null
    : { file: join(options.graphCache, 'graph', `${key}.shared.json`), key }
}

function readVerdicts(file: string, key: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return []
    if (Reflect.get(parsed, 'format') !== VERDICTS_FORMAT || Reflect.get(parsed, 'key') !== key) {
      return []
    }
    const shared: unknown = Reflect.get(parsed, 'shared')
    return Array.isArray(shared) ? shared.filter((path) => typeof path === 'string') : []
  } catch {
    return []
  }
}

/** Seeds `state.shared` with an earlier run's verdicts, once per worker. */
export function readSharedVerdicts(state: ReevaluateState, options: LoaderOptions): void {
  if (state.verdictsRead) return
  state.verdictsRead = true
  const where = verdictsFileOf(options)
  if (where === null) return
  for (const path of readVerdicts(where.file, where.key)) {
    if (!state.active.has(path)) state.shared.add(path)
  }
}

const NONCE = `${process.pid}.${threadId}.${randomBytes(4).toString('hex')}`

/**
 * Writes the worker's shared verdicts merged with the copy on disk, less every file this worker
 * evaluates per file (seeded or learned: such a verdict was another run's mistake, or the per-file
 * set took the file since). Only when the set grew; a failure is swallowed.
 */
export function writeSharedVerdicts(state: ReevaluateState, options: LoaderOptions): void {
  if (!state.sharedGrew) return
  state.sharedGrew = false
  const where = verdictsFileOf(options)
  if (where === null) return
  const temp = `${where.file}.${NONCE}.tmp`
  try {
    const merged = new Set([...readVerdicts(where.file, where.key), ...state.shared])
    for (const path of state.active) merged.delete(path)
    for (const path of state.pending) merged.delete(path)
    const body: VerdictsFile = { format: VERDICTS_FORMAT, key: where.key, shared: [...merged] }
    mkdirSync(dirname(where.file), { recursive: true })
    writeFileSync(temp, JSON.stringify(body))
    renameSync(temp, where.file)
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Nothing to clean up, or nothing that can be: the verdicts are only a speed-up.
    }
  }
}
