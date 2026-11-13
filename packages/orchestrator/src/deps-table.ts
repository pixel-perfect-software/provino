// U5: a worker names each module path once. Its `deps` events carry the paths it had not sent
// before (`added`) and, for every module the file loaded, a number (`ids`); this table, one per
// worker for the worker's whole life, turns them back into the list the worker meant.
import type { WorkerEvent } from '@provino/types'
import { OrchestratorError } from './errors.ts'

/** A worker's `deps` event. */
export type DepsEvent = Extract<WorkerEvent, { readonly type: 'deps' }>

/**
 * The paths one worker has named in its `deps` events, by id.
 * @internal
 */
export interface DepsTable {
  /**
   * Takes in what `event` adds and returns the modules it lists, in the worker's order. Throws
   * `ORCH_BAD_EVENT` for an id the worker never named.
   */
  resolve(event: DepsEvent): readonly string[]
}

/**
 * A worker's table, empty: its first `deps` event names every path it lists.
 * @internal
 */
export function createDepsTable(): DepsTable {
  const paths: string[] = []
  return {
    resolve(event) {
      for (const path of event.added) paths.push(path)
      return event.ids.map((id) => {
        const path = paths[id]
        if (path === undefined) {
          throw new OrchestratorError(
            'ORCH_BAD_EVENT',
            `A worker sent a deps event for a module id it never named (${id}; it has named ${paths.length})`,
          )
        }
        return path
      })
    },
  }
}
