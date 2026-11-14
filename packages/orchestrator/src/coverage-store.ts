// T8.8, the coordinator's half of collection: the `coverage` events a run's workers send, decoded
// into `RawCoverage` and kept in arrival order for the provider to merge (B23b Phase 4). A worker
// sends an Istanbul file's maps once, so the store keeps each worker's known maps and puts them
// back into the takes that follow.
import { expandIstanbulData, type KnownMaps } from '@provino/coverage/node'
import type { RawCoverage, WorkerEvent } from '@provino/types'
import { OrchestratorError } from './errors.ts'

/** The `coverage` arm of a worker's events. */
type CoverageEvent = Extract<WorkerEvent, { readonly type: 'coverage' }>

/**
 * What a run collected from its workers.
 * @public
 */
export interface RawCoverageStore {
  /** Decodes one `coverage` event of worker `workerId` and keeps it. Throws `ORCH_BAD_EVENT` for one it can't read. */
  add(workerId: number, event: CoverageEvent): void
  /** Everything collected so far, in arrival order. */
  readonly entries: readonly RawCoverage[]
}

function badEvent(why: string, cause?: unknown): OrchestratorError {
  return new OrchestratorError(
    'ORCH_BAD_EVENT',
    `A worker sent a coverage event ${why}`,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Creates the store of one run.
 * @public
 */
export function createRawCoverageStore(): RawCoverageStore {
  const entries: RawCoverage[] = []
  /** Per worker: the maps its Istanbul files came with. A worker's takes arrive in order. */
  const known = new Map<number, KnownMaps>()
  return {
    entries,
    add(workerId, event) {
      if (event.payload.type !== 'json') {
        throw badEvent(
          `with a ${event.payload.type} payload, which the coordinator does not read yet`,
        )
      }
      let raw: RawCoverage
      try {
        raw = JSON.parse(event.payload.json) as RawCoverage
      } catch (cause) {
        throw badEvent('whose payload is not JSON', cause)
      }
      if (raw.kind === 'istanbul') {
        let maps = known.get(workerId)
        if (maps === undefined) {
          maps = new Map()
          known.set(workerId, maps)
        }
        try {
          entries.push({ ...raw, data: expandIstanbulData(maps, raw.data) })
        } catch (cause) {
          throw badEvent('that cannot be expanded', cause)
        }
        return
      }
      if (raw.kind !== 'v8') throw badEvent('of an unknown kind')
      entries.push(raw)
    },
  }
}
