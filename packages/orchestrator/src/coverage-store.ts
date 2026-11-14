// T8.8, the coordinator's half of collection: the `coverage` events a run's workers send, decoded
// into `RawCoverage` and kept in arrival order for the provider to merge (B23b Phase 4). A worker
// sends an Istanbul file's maps once, so the store keeps each worker's known maps and puts them
// back into the takes that follow. A V8 module's code and map are kept once per path, from the
// first take that had them (Jest's first `codeTransformResult` of a URL); a later take keeps the
// module's name only, and a worker started later is told the `transformKey`s held, so it sends
// none of them again (`WorkerInit.coverageModules`).
import { expandIstanbulData, type KnownMaps } from '@provino/coverage/node'
import type {
  ExecutedModuleInfo,
  ExecutedModuleRef,
  RawCoverage,
  WorkerEvent,
} from '@provino/types'
import { OrchestratorError } from './errors.ts'

/** The `coverage` arm of a worker's events. */
type CoverageEvent = Extract<WorkerEvent, { readonly type: 'coverage' }>

/**
 * What a run collected from its workers.
 * @public
 */
export interface RawCoverageStore {
  /**
   * Decodes one `coverage` event of worker `workerId`, keeps it, and returns it as the worker sent
   * it (decoded). Throws `ORCH_BAD_EVENT` for one it can't read.
   */
  add(workerId: number, event: CoverageEvent): RawCoverage
  /** Everything collected so far, in arrival order. */
  readonly entries: readonly RawCoverage[]
  /** The `transformKey`s of the V8 modules whose code and map the store holds. */
  readonly v8Modules: ReadonlySet<string>
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
  /** The paths whose V8 module the store holds with its code, and their keys. */
  const v8Paths = new Set<string>()
  const v8Modules = new Set<string>()
  return {
    entries,
    v8Modules,
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
        let expanded: RawCoverage
        try {
          expanded = { ...raw, data: expandIstanbulData(maps, raw.data) }
        } catch (cause) {
          throw badEvent('that cannot be expanded', cause)
        }
        entries.push(expanded)
        return expanded
      }
      if (raw.kind !== 'v8') throw badEvent('of an unknown kind')
      if (raw.modules === undefined) {
        entries.push(raw)
        return raw
      }
      const modules = raw.modules.map((info): ExecutedModuleInfo | ExecutedModuleRef => {
        if (!('code' in info)) return info
        if (v8Paths.has(info.url)) {
          const { code: _code, map: _map, ...ref } = info
          return ref
        }
        v8Paths.add(info.url)
        v8Modules.add(info.transformKey)
        return info
      })
      entries.push({ ...raw, modules })
      return raw
    },
  }
}
